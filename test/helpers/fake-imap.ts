import { EmailMcpError } from '../../src/core/errors.js';
import type {
  ImapListUidsOptions,
  ImapMailboxInfo,
  ImapMailboxState,
  ImapRawMessage,
  ImapSearchRequest,
  ImapTransport,
} from '../../src/providers/imap-smtp/imap-transport.js';

export interface FakeImapMessage {
  uid: number;
  source: Buffer | string;
  flags?: string[];
}

export interface FakeImapFolder {
  path: string;
  uidValidity?: string;
  messages: FakeImapMessage[];
}

interface StoredFolder {
  path: string;
  uidValidity: string;
  messages: FakeImapMessage[];
}

function toRawMessage(message: FakeImapMessage): ImapRawMessage {
  const source = typeof message.source === 'string' ? Buffer.from(message.source, 'utf8') : message.source;
  return {
    uid: message.uid,
    source,
    flags: [...(message.flags ?? [])],
    size: source.length,
  };
}

function dateHeader(source: Buffer): Date | null {
  const text = source.toString('utf8', 0, Math.min(source.length, 4_000));
  const match = /^date:\s*(.+)$/im.exec(text);
  if (!match || match[1] === undefined) {
    return null;
  }
  const date = new Date(match[1].trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * In-memory IMAP transport. Implements the same narrow interface as the real
 * imapflow transport so provider behavior can be tested without a network.
 */
export class FakeImapTransport implements ImapTransport {
  private readonly folders = new Map<string, StoredFolder>();
  private opened: string | null = null;
  readonly searchRequests: ImapSearchRequest[] = [];
  readonly fetchCalls: number[][] = [];
  closeCalls = 0;

  constructor(folders: FakeImapFolder[]) {
    for (const folder of folders) {
      this.folders.set(folder.path, {
        path: folder.path,
        uidValidity: folder.uidValidity ?? '1',
        messages: folder.messages,
      });
    }
  }

  setUidValidity(path: string, uidValidity: string): void {
    const folder = this.folders.get(path);
    if (folder === undefined) {
      throw new Error(`Unknown fake folder: ${path}`);
    }
    folder.uidValidity = uidValidity;
  }

  async listMailboxes(): Promise<ImapMailboxInfo[]> {
    return [...this.folders.values()].map((folder) => ({
      path: folder.path,
      name: folder.path,
      delimiter: '/',
      specialUse: null,
      selectable: true,
    }));
  }

  async openMailbox(path: string): Promise<ImapMailboxState> {
    const folder = this.folders.get(path);
    if (folder === undefined) {
      throw new EmailMcpError('FOLDER_NOT_FOUND', `Folder "${path}" does not exist`);
    }
    this.opened = path;
    const maxUid = folder.messages.reduce((max, message) => Math.max(max, message.uid), 0);
    return {
      path,
      uidValidity: folder.uidValidity,
      uidNext: maxUid + 1,
      exists: folder.messages.length,
    };
  }

  private requireOpen(): StoredFolder {
    if (this.opened === null) {
      throw new EmailMcpError('PROVIDER_ERROR', 'No mailbox is selected');
    }
    const folder = this.folders.get(this.opened);
    if (folder === undefined) {
      throw new EmailMcpError('FOLDER_NOT_FOUND', `Folder "${this.opened}" does not exist`);
    }
    return folder;
  }

  async listUids(options: ImapListUidsOptions): Promise<number[]> {
    const folder = this.requireOpen();
    return folder.messages
      .map((message) => message.uid)
      .filter((uid) => options.beforeUid === undefined || uid < options.beforeUid)
      .sort((a, b) => b - a)
      .slice(0, options.limit);
  }

  async fetchMessages(uids: readonly number[]): Promise<ImapRawMessage[]> {
    const folder = this.requireOpen();
    this.fetchCalls.push([...uids]);
    const wanted = new Set(uids);
    return folder.messages
      .filter((message) => wanted.has(message.uid))
      .sort((a, b) => a.uid - b.uid)
      .map(toRawMessage);
  }

  async searchUids(request: ImapSearchRequest): Promise<number[]> {
    const folder = this.requireOpen();
    this.searchRequests.push(request);
    const query = request.query?.toLowerCase();
    const matches = folder.messages.filter((message) => {
      if (request.beforeUid !== undefined && message.uid >= request.beforeUid) {
        return false;
      }
      if (request.unseen === true && (message.flags ?? []).includes('\\Seen')) {
        return false;
      }
      const date = dateHeader(toRawMessage(message).source);
      if (request.since !== undefined && (date === null || date.getTime() < request.since.getTime())) {
        return false;
      }
      if (request.before !== undefined && (date === null || date.getTime() >= request.before.getTime())) {
        return false;
      }
      if (query !== undefined && query.length > 0) {
        return toRawMessage(message).source.toString('utf8').toLowerCase().includes(query);
      }
      return true;
    });
    return matches
      .map((message) => message.uid)
      .sort((a, b) => b - a)
      .slice(0, request.limit);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.opened = null;
  }
}
