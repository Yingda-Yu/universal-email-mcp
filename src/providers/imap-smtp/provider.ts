import { EmailMcpError } from '../../core/errors.js';
import { decodeUidCursor, encodeUidCursor } from '../../core/cursor.js';
import { LIMITS } from '../../core/limits.js';
import { assertMessageSize, makeSnippet, parseRawMessage } from '../../core/mime.js';
import { decodeMessageRef, encodeMessageRef } from '../../core/message-ref.js';
import { buildThread, type ThreadCandidate } from '../../core/thread.js';
import type {
  EmailProvider,
  FolderInfo,
  GetMessageOptions,
  GetThreadOptions,
  ListMessagesOptions,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  Page,
  ProviderCapabilities,
  ResolvedAccountConfig,
  SearchMessagesOptions,
  SendReceipt,
  ThreadResult,
} from '../../core/types.js';
import { validateFolderPath, validateIsoDate, validateSearchQuery } from '../../core/validate.js';
import type { ImapRawMessage, ImapTransport } from './imap-transport.js';
import type { SmtpSender } from './smtp-sender.js';

function summarizeWarnings(warnings: readonly string[]): string | undefined {
  const relevant = warnings.filter((warning) => warning !== 'html_sanitized');
  return relevant.length === 0 ? undefined : relevant.join('; ');
}

export interface ImapSmtpProviderOptions {
  config: ResolvedAccountConfig;
  imap: ImapTransport;
  smtpSender: SmtpSender | null;
  maxMessageBytes?: number;
  threadCandidateLimit?: number;
}

/**
 * Provider-agnostic IMAP read + SMTP send implementation. All mailbox access is
 * serialized because IMAP has a single selected-mailbox state per connection.
 */
export class ImapSmtpProvider implements EmailProvider {
  readonly kind = 'imap-smtp' as const;
  private readonly config: ResolvedAccountConfig;
  private readonly imap: ImapTransport;
  private readonly smtpSender: SmtpSender | null;
  private readonly maxMessageBytes: number;
  private readonly threadCandidateLimit: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ImapSmtpProviderOptions) {
    this.config = options.config;
    this.imap = options.imap;
    this.smtpSender = options.smtpSender;
    this.maxMessageBytes = options.maxMessageBytes ?? LIMITS.maxMessageBytes;
    this.threadCandidateLimit = options.threadCandidateLimit ?? LIMITS.maxThreadCandidates;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  capabilities(): ProviderCapabilities {
    return {
      implemented: true,
      read: true,
      search: 'server',
      thread: 'best-effort',
      send: this.smtpSender !== null,
      remoteDrafts: false,
      attachments: false,
      flags: false,
    };
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.runExclusive(async () => this.imap.listMailboxes());
  }

  private async summaryFromRaw(
    folder: string,
    uidValidity: string,
    raw: ImapRawMessage,
  ): Promise<MessageSummary> {
    const base = {
      messageId: encodeMessageRef('imap1', folder, uidValidity, raw.uid),
      folder,
      uid: raw.uid,
      uidValidity,
      unread: !raw.flags.includes('\\Seen'),
    };
    if (raw.source.length > this.maxMessageBytes) {
      return {
        ...base,
        subject: '(message too large to preview)',
        from: [],
        to: [],
        date: null,
        snippet: '',
        hasAttachments: false,
        parseWarning: 'message_too_large',
      };
    }
    const parsed = await parseRawMessage(raw.source, { maxBodyChars: 500 });
    const warning = summarizeWarnings(parsed.warnings);
    return {
      ...base,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      date: parsed.date === null ? null : parsed.date.toISOString(),
      snippet: makeSnippet(parsed.text, parsed.html),
      hasAttachments: parsed.attachments.length > 0,
      ...(warning === undefined ? {} : { parseWarning: warning }),
    };
  }

  private async summariesForUids(folder: string, uidValidity: string, uids: readonly number[]): Promise<MessageSummary[]> {
    const raws = await this.imap.fetchMessages(uids);
    const byUid = new Map<number, ImapRawMessage>();
    for (const raw of raws) {
      byUid.set(raw.uid, raw);
    }
    const summaries: MessageSummary[] = [];
    for (const uid of uids) {
      const raw = byUid.get(uid);
      if (raw === undefined) {
        continue;
      }
      summaries.push(await this.summaryFromRaw(folder, uidValidity, raw));
    }
    return summaries;
  }

  async listMessages(options: ListMessagesOptions): Promise<Page<MessageSummary>> {
    const folder = validateFolderPath(options.folder);
    return this.runExclusive(async () => {
      const state = await this.imap.openMailbox(folder);
      const beforeUid = options.cursor === undefined ? undefined : decodeUidCursor(options.cursor);
      const uids =
        options.unreadOnly === true
          ? await this.imap.searchUids({ unseen: true, beforeUid, limit: options.limit })
          : await this.imap.listUids({ beforeUid, limit: options.limit });
      const items = await this.summariesForUids(folder, state.uidValidity, uids);
      const lastUid = uids.at(-1);
      return {
        items,
        nextCursor: uids.length === options.limit && lastUid !== undefined ? encodeUidCursor(lastUid) : null,
      };
    });
  }

  async searchMessages(options: SearchMessagesOptions): Promise<Page<MessageSummary>> {
    const folder = validateFolderPath(options.folder);
    const query = validateSearchQuery(options.query);
    const since = options.since === undefined ? undefined : validateIsoDate(options.since, 'since');
    const before = options.before === undefined ? undefined : validateIsoDate(options.before, 'before');
    return this.runExclusive(async () => {
      const state = await this.imap.openMailbox(folder);
      const beforeUid = options.cursor === undefined ? undefined : decodeUidCursor(options.cursor);
      const uids = await this.imap.searchUids({
        query,
        since,
        before,
        beforeUid,
        limit: options.limit,
      });
      const items = await this.summariesForUids(folder, state.uidValidity, uids);
      const lastUid = uids.at(-1);
      return {
        items,
        nextCursor: uids.length === options.limit && lastUid !== undefined ? encodeUidCursor(lastUid) : null,
      };
    });
  }

  private async getMessageUnlocked(messageId: string, options: GetMessageOptions): Promise<MessageDetail> {
    const ref = decodeMessageRef(messageId, 'imap1');
    const state = await this.imap.openMailbox(ref.folder);
    if (state.uidValidity !== ref.uidValidity) {
      throw new EmailMcpError('MESSAGE_STALE', 'The mailbox UIDVALIDITY changed; re-list messages before reading', {
        details: { reason: 'uidvalidity_changed' },
      });
    }
    const raws = await this.imap.fetchMessages([ref.uid]);
    const raw = raws.find((message) => message.uid === ref.uid);
    if (raw === undefined) {
      throw new EmailMcpError('MESSAGE_NOT_FOUND', 'Message is no longer available in the mailbox');
    }
    assertMessageSize(raw.source.length, this.maxMessageBytes);
    const parsed = await parseRawMessage(raw.source, { maxBodyChars: options.maxBodyChars });
    const warnings = [...parsed.warnings];
    let html = parsed.html;
    if (!options.includeHtml && html !== null) {
      html = null;
      warnings.push('html_not_requested');
    }
    const warning = summarizeWarnings(warnings);
    return {
      messageId: encodeMessageRef('imap1', ref.folder, state.uidValidity, ref.uid),
      folder: ref.folder,
      uid: ref.uid,
      uidValidity: state.uidValidity,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      date: parsed.date === null ? null : parsed.date.toISOString(),
      snippet: makeSnippet(parsed.text, parsed.html),
      unread: !raw.flags.includes('\\Seen'),
      hasAttachments: parsed.attachments.length > 0,
      messageIdHeader: parsed.messageIdHeader,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      text: parsed.text,
      html,
      truncated: parsed.truncated,
      attachments: parsed.attachments,
      contentTrust: 'untrusted-external',
      warnings,
      ...(warning === undefined ? {} : { parseWarning: warning }),
    };
  }

  async getMessage(messageId: string, options: GetMessageOptions): Promise<MessageDetail> {
    return this.runExclusive(async () => this.getMessageUnlocked(messageId, options));
  }

  async getThread(messageId: string, options: GetThreadOptions): Promise<ThreadResult> {
    return this.runExclusive(async () => {
      const seed = await this.getMessageUnlocked(messageId, {
        includeHtml: false,
        maxBodyChars: 500,
      });
      const state = await this.imap.openMailbox(seed.folder);
      const uids = await this.imap.listUids({ limit: this.threadCandidateLimit });
      const raws = await this.imap.fetchMessages(uids);
      const seedCandidate: ThreadCandidate = {
        summary: seed,
        messageIdHeader: seed.messageIdHeader,
        inReplyTo: seed.inReplyTo,
        references: seed.references,
      };
      const candidates: ThreadCandidate[] = [];
      for (const raw of raws) {
        if (raw.uid === seed.uid) {
          continue;
        }
        if (raw.source.length > this.maxMessageBytes) {
          continue;
        }
        const parsed = await parseRawMessage(raw.source, { maxBodyChars: 200 });
        const summary: MessageSummary = {
          messageId: encodeMessageRef('imap1', seed.folder, state.uidValidity, raw.uid),
          folder: seed.folder,
          uid: raw.uid,
          uidValidity: state.uidValidity,
          subject: parsed.subject,
          from: parsed.from,
          to: parsed.to,
          date: parsed.date === null ? null : parsed.date.toISOString(),
          snippet: makeSnippet(parsed.text, parsed.html),
          unread: !raw.flags.includes('\\Seen'),
          hasAttachments: parsed.attachments.length > 0,
        };
        candidates.push({
          summary,
          messageIdHeader: parsed.messageIdHeader,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
        });
      }
      const result = buildThread(seedCandidate, candidates, options.limit);
      return {
        ...result,
        warnings: [...result.warnings, 'thread_is_best_effort'],
      };
    });
  }

  async send(message: OutgoingMessage): Promise<SendReceipt> {
    if (this.smtpSender === null) {
      throw new EmailMcpError('CAPABILITY_UNSUPPORTED', 'SMTP is not configured for this account');
    }
    return this.runExclusive(async () => this.smtpSender!.send(message));
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    await Promise.allSettled([this.imap.close(), this.smtpSender?.close()]);
  }
}
