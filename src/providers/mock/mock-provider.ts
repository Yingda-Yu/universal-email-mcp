import { EmailMcpError } from '../../core/errors.js';
import { decodeOffsetCursor, encodeOffsetCursor } from '../../core/cursor.js';
import { makeSnippet, sanitizeUntrustedHtml } from '../../core/mime.js';
import { decodeMessageRef, encodeMessageRef } from '../../core/message-ref.js';
import { validateOutgoingMessage, type ValidatedOutgoingMessage } from '../../core/outgoing.js';
import { buildThread, type ThreadCandidate } from '../../core/thread.js';
import type {
  AttachmentMeta,
  EmailProvider,
  FolderInfo,
  GetMessageOptions,
  GetThreadOptions,
  ListMessagesOptions,
  MailAddress,
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

export interface MockMessageSeed {
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string[];
  date: string;
  text?: string;
  html?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  unread?: boolean;
  attachments?: AttachmentMeta[];
}

export interface MockAccountSeed {
  folders?: string[];
  messages: MockMessageSeed[];
}

export interface MockOutboxEntry {
  from: string;
  envelope: ValidatedOutgoingMessage;
  providerMessageId: string;
  sentAt: string;
}

export interface MockProviderOptions {
  config: ResolvedAccountConfig;
  seed: MockAccountSeed;
  /** Deterministic failure injection used by tests. */
  sendFailure?: 'authentication' | 'connection' | 'rejected' | null;
}

interface StoredMessage {
  folder: string;
  uid: number;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  date: string | null;
  text: string | null;
  html: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  unread: boolean;
  attachments: AttachmentMeta[];
}

function parseSeedAddress(value: string, field: string): MailAddress {
  const match = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>]+)>\s*$/.exec(value);
  if (match && match[2] !== undefined) {
    const parsed = parseSeedAddress(match[2], field);
    const name = match[1]?.trim();
    return name !== undefined && name.length > 0 ? { name, address: parsed.address } : parsed;
  }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(value.trim())) {
    throw new EmailMcpError('INVALID_ARGUMENT', `Invalid mock ${field} address`);
  }
  return { address: value.trim() };
}

function parseSeedAddressList(values: readonly string[] | undefined, field: string): MailAddress[] {
  return (values ?? []).map((value) => parseSeedAddress(value, field));
}

function normalizeHeaderId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^<[^<>\s]+>$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[^<>\s]+$/.test(trimmed)) {
    return `<${trimmed}>`;
  }
  throw new EmailMcpError('INVALID_ARGUMENT', 'Invalid mock Message-ID header');
}

function specialUseFor(folder: string): string | null {
  const normalized = folder.toLowerCase();
  if (normalized === 'sent') {
    return '\\Sent';
  }
  if (normalized === 'drafts') {
    return '\\Drafts';
  }
  if (normalized === 'archive') {
    return '\\Archive';
  }
  if (normalized === 'trash') {
    return '\\Trash';
  }
  if (normalized === 'junk' || normalized === 'spam') {
    return '\\Junk';
  }
  if (normalized === 'inbox') {
    return '\\Inbox';
  }
  return null;
}

/**
 * Fully deterministic in-memory provider used for local development, demos,
 * and the test suite. It never opens a network connection.
 */
export class MockEmailProvider implements EmailProvider {
  readonly kind = 'mock' as const;
  private readonly config: ResolvedAccountConfig;
  private readonly folders: FolderInfo[];
  private readonly messages: StoredMessage[];
  private readonly sendFailure: MockProviderOptions['sendFailure'];
  private readonly outbox: MockOutboxEntry[] = [];
  private sendCounter = 0;

  constructor(options: MockProviderOptions) {
    this.config = options.config;
    this.sendFailure = options.sendFailure ?? null;
    const folderNames = new Set<string>(options.seed.folders ?? ['INBOX']);
    for (const message of options.seed.messages) {
      folderNames.add(message.folder);
    }
    if (folderNames.size === 0) {
      folderNames.add('INBOX');
    }
    this.folders = [...folderNames].map((path) => ({
      path,
      name: path,
      delimiter: '/',
      specialUse: specialUseFor(path),
      selectable: true,
    }));
    this.messages = options.seed.messages.map((message) => {
      const date = new Date(message.date);
      return {
        folder: validateFolderPath(message.folder),
        uid: message.uid,
        subject: message.subject,
        from: parseSeedAddressList([message.from], 'from'),
        to: parseSeedAddressList(message.to, 'to'),
        cc: parseSeedAddressList(message.cc, 'cc'),
        replyTo: parseSeedAddressList(message.replyTo, 'reply_to'),
        date: Number.isNaN(date.getTime()) ? null : date.toISOString(),
        text: message.text ?? null,
        html: message.html ?? null,
        messageIdHeader: normalizeHeaderId(message.messageId),
        inReplyTo: normalizeHeaderId(message.inReplyTo),
        references: (message.references ?? []).map((reference) => normalizeHeaderId(reference) ?? ''),
        unread: message.unread ?? false,
        attachments: message.attachments ?? [],
      };
    });
  }

  capabilities(): ProviderCapabilities {
    return {
      implemented: true,
      read: true,
      search: 'partial',
      thread: 'best-effort',
      send: this.config.sendEnabled,
      remoteDrafts: false,
      attachments: false,
      flags: false,
    };
  }

  private folderMessages(folder: string): StoredMessage[] {
    const valid = validateFolderPath(folder);
    if (!this.folders.some((entry) => entry.path === valid)) {
      throw new EmailMcpError('FOLDER_NOT_FOUND', `Folder "${valid}" does not exist for this mock account`);
    }
    return this.messages
      .filter((message) => message.folder === valid)
      .sort((a, b) => {
        const first = a.date === null ? 0 : Date.parse(a.date);
        const second = b.date === null ? 0 : Date.parse(b.date);
        return second - first || b.uid - a.uid;
      });
  }

  private toSummary(message: StoredMessage): MessageSummary {
    return {
      messageId: encodeMessageRef('mock1', message.folder, '1', message.uid),
      folder: message.folder,
      uid: message.uid,
      uidValidity: '1',
      subject: message.subject,
      from: message.from,
      to: message.to,
      date: message.date,
      snippet: makeSnippet(message.text, message.html),
      unread: message.unread,
      hasAttachments: message.attachments.length > 0,
    };
  }

  private toDetail(message: StoredMessage, options: GetMessageOptions): MessageDetail {
    const text =
      message.text === null || message.text.length <= options.maxBodyChars
        ? message.text
        : message.text.slice(0, options.maxBodyChars);
    const htmlSource =
      options.includeHtml && message.html !== null ? sanitizeUntrustedHtml(message.html) : null;
    const html =
      htmlSource === null || htmlSource.length <= options.maxBodyChars
        ? htmlSource
        : htmlSource.slice(0, options.maxBodyChars);
    const warnings: string[] = [];
    if (htmlSource !== null) {
      warnings.push('html_sanitized');
    }

    return {
      ...this.toSummary(message),
      cc: message.cc,
      replyTo: message.replyTo,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
      text,
      html,
      truncated: text !== message.text || html !== htmlSource,
      attachments: message.attachments,
      contentTrust: 'untrusted-external',
      warnings,
    };
  }

  private findMessage(messageId: string): StoredMessage {
    const ref = decodeMessageRef(messageId, 'mock1');
    if (ref.uidValidity !== '1') {
      throw new EmailMcpError('MESSAGE_STALE', 'Mock mailbox UIDVALIDITY changed', {
        details: { reason: 'uidvalidity_changed' },
      });
    }
    const message = this.messages.find((entry) => entry.folder === ref.folder && entry.uid === ref.uid);
    if (message === undefined) {
      throw new EmailMcpError('MESSAGE_NOT_FOUND', 'Message was not found in the mock account');
    }
    return message;
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.folders.map((folder) => ({ ...folder }));
  }

  async listMessages(options: ListMessagesOptions): Promise<Page<MessageSummary>> {
    const folder = validateFolderPath(options.folder);
    const offset = options.cursor === undefined ? 0 : decodeOffsetCursor(options.cursor);
    const all = this.folderMessages(folder).filter((message) => options.unreadOnly !== true || message.unread);
    const page = all.slice(offset, offset + options.limit);
    const nextOffset = offset + page.length;
    return {
      items: page.map((message) => this.toSummary(message)),
      nextCursor: nextOffset < all.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }

  async searchMessages(options: SearchMessagesOptions): Promise<Page<MessageSummary>> {
    const folder = validateFolderPath(options.folder);
    const query = validateSearchQuery(options.query).toLowerCase();
    const since = options.since === undefined ? null : validateIsoDate(options.since, 'since');
    const before = options.before === undefined ? null : validateIsoDate(options.before, 'before');
    const offset = options.cursor === undefined ? 0 : decodeOffsetCursor(options.cursor);
    const matches = this.folderMessages(folder).filter((message) => {
      if (since !== null || before !== null) {
        if (message.date === null) {
          return false;
        }
        const timestamp = Date.parse(message.date);
        if (since !== null && timestamp < since.getTime()) {
          return false;
        }
        if (before !== null && timestamp >= before.getTime()) {
          return false;
        }
      }
      const haystack = [
        message.subject,
        ...message.from.map((address) => `${address.name ?? ''} ${address.address}`),
        ...message.to.map((address) => `${address.name ?? ''} ${address.address}`),
        ...message.cc.map((address) => `${address.name ?? ''} ${address.address}`),
        message.text ?? '',
        message.html ?? '',
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(query);
    });
    const page = matches.slice(offset, offset + options.limit);
    const nextOffset = offset + page.length;
    return {
      items: page.map((message) => this.toSummary(message)),
      nextCursor: nextOffset < matches.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }

  async getMessage(messageId: string, options: GetMessageOptions): Promise<MessageDetail> {
    return this.toDetail(this.findMessage(messageId), options);
  }

  async getThread(messageId: string, options: GetThreadOptions): Promise<ThreadResult> {
    const seed = this.findMessage(messageId);
    const candidates: ThreadCandidate[] = this.messages
      .filter((message) => message.folder === seed.folder && message.uid !== seed.uid)
      .map((message) => ({
        summary: this.toSummary(message),
        messageIdHeader: message.messageIdHeader,
        inReplyTo: message.inReplyTo,
        references: message.references,
      }));
    return buildThread(
      {
        summary: this.toSummary(seed),
        messageIdHeader: seed.messageIdHeader,
        inReplyTo: seed.inReplyTo,
        references: seed.references,
      },
      candidates,
      options.limit,
    );
  }

  async send(message: OutgoingMessage): Promise<SendReceipt> {
    if (!this.config.sendEnabled) {
      throw new EmailMcpError('SEND_DISABLED', 'Sending is disabled for this mock account');
    }
    if (this.sendFailure === 'authentication') {
      throw new EmailMcpError('AUTHENTICATION_FAILED', 'Mock SMTP authentication failed');
    }
    if (this.sendFailure === 'connection') {
      throw new EmailMcpError('CONNECTION_FAILED', 'Mock SMTP connection failed', { retryable: true });
    }
    if (this.sendFailure === 'rejected') {
      throw new EmailMcpError('SMTP_SEND_FAILED', 'Mock SMTP server rejected the message');
    }
    const envelope = validateOutgoingMessage(message);
    this.sendCounter += 1;
    const sentAt = new Date().toISOString();
    const providerMessageId = `<mock-${this.sendCounter}-${Date.now()}@universal-email-mcp.invalid>`;
    this.outbox.push({
      from: this.config.email,
      envelope,
      providerMessageId,
      sentAt,
    });
    return {
      providerMessageId,
      accepted: [...envelope.to, ...envelope.cc, ...envelope.bcc],
      rejected: [],
      response: '250 2.0.0 Mock message captured (no network delivery)',
      partial: false,
      sentAt,
    };
  }

  getOutbox(): readonly MockOutboxEntry[] {
    return this.outbox.map((entry) => ({
      ...entry,
      envelope: {
        ...entry.envelope,
        to: [...entry.envelope.to],
        cc: [...entry.envelope.cc],
        bcc: [...entry.envelope.bcc],
        references: [...entry.envelope.references],
      },
    }));
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
