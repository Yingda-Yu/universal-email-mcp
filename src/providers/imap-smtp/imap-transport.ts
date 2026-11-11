import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ImapFlow } from 'imapflow';
import type { SearchObject } from 'imapflow';
import { EmailMcpError } from '../../core/errors.js';
import { redactString, truncateForError } from '../../core/redact.js';
import { assertResolvedAddressesAllowed, assertSafeRemoteHost } from '../../core/validate.js';
import { VERSION } from '../../version.js';
import type { FolderInfo } from '../../core/types.js';

export interface ImapMailboxInfo extends FolderInfo {
  selectable: boolean;
}

export interface ImapMailboxState {
  path: string;
  uidValidity: string;
  uidNext: number;
  exists: number;
}

export interface ImapRawMessage {
  uid: number;
  source: Buffer;
  flags: string[];
  size: number;
}

export interface ImapListUidsOptions {
  limit: number;
  beforeUid?: number;
}

export interface ImapSearchRequest {
  query?: string;
  since?: Date;
  before?: Date;
  unseen?: boolean;
  beforeUid?: number;
  limit: number;
}

export interface ImapTransport {
  listMailboxes(): Promise<ImapMailboxInfo[]>;
  openMailbox(path: string): Promise<ImapMailboxState>;
  listUids(options: ImapListUidsOptions): Promise<number[]>;
  fetchMessages(uids: readonly number[]): Promise<ImapRawMessage[]>;
  searchUids(request: ImapSearchRequest): Promise<number[]>;
  close(): Promise<void>;
}

export interface ImapTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  username: string;
  password: string;
  allowPrivateHosts: boolean;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export function mapImapError(error: unknown): EmailMcpError {
  if (error instanceof EmailMcpError) {
    return error;
  }
  const candidate = error as {
    authenticationFailed?: boolean;
    code?: string;
    message?: string;
    responseText?: string;
  };
  const message = redactString(
    truncateForError(candidate.message ?? candidate.responseText ?? 'IMAP operation failed'),
  );
  if (candidate.authenticationFailed === true) {
    return new EmailMcpError('AUTHENTICATION_FAILED', 'IMAP authentication failed', { cause: error });
  }
  const code = candidate.code ?? '';
  if (/timeout|ETIMEDOUT|GreetingTimeout|ConnectionTimeout/i.test(code) || /timeout/i.test(message)) {
    return new EmailMcpError('TIMEOUT', 'IMAP operation timed out', { retryable: true, cause: error });
  }
  if (/certificate|self.signed|TLS|SSL/i.test(`${code} ${message}`)) {
    return new EmailMcpError('CONNECTION_FAILED', 'IMAP TLS connection could not be established securely', {
      details: { reason: 'tls' },
      cause: error,
    });
  }
  if (/MailboxDoesNotExist|Mailbox not found|does not exist/i.test(`${code} ${message}`)) {
    return new EmailMcpError('FOLDER_NOT_FOUND', 'IMAP folder was not found', { cause: error });
  }
  if (
    /NoConnection|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|ConnectionNotAvailable/i.test(code)
  ) {
    return new EmailMcpError('CONNECTION_FAILED', 'Could not connect to the IMAP server', {
      retryable: true,
      cause: error,
    });
  }
  return new EmailMcpError('PROVIDER_ERROR', message, { cause: error });
}

/**
 * Real IMAP transport. Wraps imapflow and keeps a single lazily connected
 * session. Callers serialize operations; a mailbox may only be selected once.
 */
export class ImapFlowTransport implements ImapTransport {
  private readonly options: ImapTransportOptions;
  private client: ImapFlow | null = null;
  private connectPromise: Promise<ImapFlow> | null = null;

  constructor(options: ImapTransportOptions) {
    this.options = options;
  }

  private async ensureSafeHost(): Promise<void> {
    const host = assertSafeRemoteHost(this.options.host, this.options.allowPrivateHosts);
    if (net.isIP(host) !== 0) {
      assertResolvedAddressesAllowed([host], this.options.allowPrivateHosts);
      return;
    }
    let addresses: string[];
    try {
      const results = await lookup(host, { all: true, verbatim: true });
      addresses = results.map((entry) => entry.address);
    } catch (error) {
      throw new EmailMcpError('CONNECTION_FAILED', 'IMAP server hostname could not be resolved', {
        retryable: true,
        cause: error,
      });
    }
    if (addresses.length === 0) {
      throw new EmailMcpError('CONNECTION_FAILED', 'IMAP server hostname resolved to no addresses');
    }
    assertResolvedAddressesAllowed(addresses, this.options.allowPrivateHosts);
  }

  private async connect(): Promise<ImapFlow> {
    if (this.client !== null) {
      return this.client;
    }
    if (this.connectPromise !== null) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      await this.ensureSafeHost();
      const client = new ImapFlow({
        host: this.options.host,
        port: this.options.port,
        secure: this.options.secure,
        doSTARTTLS: this.options.secure ? undefined : this.options.requireTls,
        auth: {
          user: this.options.username,
          pass: this.options.password,
        },
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          servername: this.options.host,
        },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: this.options.connectionTimeoutMs ?? 15_000,
        greetingTimeout: this.options.greetingTimeoutMs ?? 10_000,
        socketTimeout: this.options.socketTimeoutMs ?? 30_000,
        clientInfo: { name: 'universal-email-mcp', version: VERSION },
      });
      try {
        await client.connect();
      } catch (error) {
        client.close();
        throw mapImapError(error);
      }
      this.client = client;
      return client;
    })();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async listMailboxes(): Promise<ImapMailboxInfo[]> {
    const client = await this.connect();
    try {
      const mailboxes = await client.list();
      return mailboxes.map((mailbox) => ({
        path: mailbox.path,
        name: mailbox.name,
        delimiter: mailbox.delimiter,
        specialUse: mailbox.specialUse ?? null,
        selectable: !mailbox.flags.has('\\Noselect'),
      }));
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async openMailbox(path: string): Promise<ImapMailboxState> {
    const client = await this.connect();
    try {
      if (client.mailbox !== false && client.mailbox !== undefined && client.mailbox.path === path) {
        return {
          path,
          uidValidity: client.mailbox.uidValidity.toString(),
          uidNext: client.mailbox.uidNext,
          exists: client.mailbox.exists,
        };
      }
      const mailbox = await client.mailboxOpen(path);
      return {
        path,
        uidValidity: mailbox.uidValidity.toString(),
        uidNext: mailbox.uidNext,
        exists: mailbox.exists,
      };
    } catch (error) {
      throw mapImapError(error);
    }
  }

  private async fetchUidRange(start: number, end: number): Promise<number[]> {
    const client = await this.connect();
    const uids: number[] = [];
    for await (const message of client.fetch(`${start}:${end}`, { uid: true }, { uid: true })) {
      uids.push(message.uid);
    }
    return uids;
  }

  async listUids(options: ImapListUidsOptions): Promise<number[]> {
    const client = await this.connect();
    const mailbox = client.mailbox;
    if (mailbox === false) {
      throw new EmailMcpError('PROVIDER_ERROR', 'No IMAP mailbox is selected');
    }
    let end = options.beforeUid !== undefined ? options.beforeUid - 1 : mailbox.uidNext - 1;
    const batchSize = Math.max(options.limit * 2, 20);
    const collected: number[] = [];
    let iterations = 0;
    while (end >= 1 && collected.length < options.limit && iterations < 50) {
      iterations += 1;
      const start = Math.max(1, end - batchSize + 1);
      try {
        const batch = await this.fetchUidRange(start, end);
        batch.sort((a, b) => b - a);
        collected.push(...batch);
      } catch (error) {
        throw mapImapError(error);
      }
      end = start - 1;
    }
    return [...new Set(collected)].sort((a, b) => b - a).slice(0, options.limit);
  }

  async fetchMessages(uids: readonly number[]): Promise<ImapRawMessage[]> {
    if (uids.length === 0) {
      return [];
    }
    const client = await this.connect();
    const messages: ImapRawMessage[] = [];
    try {
      for await (const message of client.fetch(
        uids.join(','),
        { uid: true, source: true, flags: true, size: true },
        { uid: true },
      )) {
        if (message.source === undefined) {
          continue;
        }
        messages.push({
          uid: message.uid,
          source: message.source,
          flags: [...(message.flags ?? new Set<string>())],
          size: message.size ?? message.source.length,
        });
      }
    } catch (error) {
      throw mapImapError(error);
    }
    return messages;
  }

  async searchUids(request: ImapSearchRequest): Promise<number[]> {
    const client = await this.connect();
    if (request.beforeUid !== undefined && request.beforeUid <= 1) {
      return [];
    }
    const criteria: SearchObject = {};
    if (request.query !== undefined && request.query.length > 0) {
      criteria.or = [
        { subject: request.query },
        { from: request.query },
        { to: request.query },
        { body: request.query },
      ];
    }
    if (request.since !== undefined) {
      criteria.since = request.since;
    }
    if (request.before !== undefined) {
      criteria.before = request.before;
    }
    if (request.unseen === true) {
      criteria.seen = false;
    }
    if (request.beforeUid !== undefined) {
      criteria.uid = `1:${request.beforeUid - 1}`;
    }
    if (Object.keys(criteria).length === 0) {
      criteria.all = true;
    }
    try {
      const result = await client.search(criteria, { uid: true });
      if (!Array.isArray(result)) {
        return [];
      }
      return [...new Set(result)].sort((a, b) => b - a).slice(0, request.limit);
    } catch (error) {
      throw mapImapError(error);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client === null) {
      return;
    }
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
