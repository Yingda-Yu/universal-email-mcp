import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DRAFT_ID_PATTERN, ACCOUNT_ID_PATTERN } from '../config/schema.js';
import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';
import type { MailAddress, SendReceipt } from './types.js';

export interface DraftContent {
  accountId: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
  replyToMessageId: string | null;
}

export interface CreateDraftInput extends Omit<DraftContent, 'accountId'> {
  accountId: string;
}

export interface Draft extends DraftContent {
  version: 1;
  id: string;
  status: 'draft' | 'sent';
  createdAt: string;
  sentAt: string | null;
  contentHash: string;
  receipt: SendReceipt | null;
}

export interface DraftStoreOptions {
  dataDir: string;
  now?: () => Date;
}

function canonicalContent(content: DraftContent): string {
  return JSON.stringify({
    accountId: content.accountId,
    to: content.to.map((address) => ({ name: address.name ?? null, address: address.address.toLowerCase() })),
    cc: content.cc.map((address) => ({ name: address.name ?? null, address: address.address.toLowerCase() })),
    bcc: content.bcc.map((address) => ({ name: address.name ?? null, address: address.address.toLowerCase() })),
    subject: content.subject,
    text: content.text,
    html: content.html,
    inReplyTo: content.inReplyTo,
    references: content.references,
    replyToMessageId: content.replyToMessageId,
  });
}

export function computeDraftHash(content: DraftContent): string {
  return createHash('sha256').update(canonicalContent(content), 'utf8').digest('hex');
}

function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'account_id has an invalid format');
  }
}

function assertDraftId(draftId: string): void {
  if (!DRAFT_ID_PATTERN.test(draftId)) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'draft_id has an invalid format');
  }
}

function isAddressArray(value: unknown): value is MailAddress[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as MailAddress).address === 'string' &&
        ((entry as MailAddress).name === undefined || typeof (entry as MailAddress).name === 'string'),
    )
  );
}

function parseDraft(raw: string, accountId: string, draftId: string): Draft {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EmailMcpError('DRAFT_CONTENT_CHANGED', 'Draft file is corrupted');
  }
  if (typeof value !== 'object' || value === null) {
    throw new EmailMcpError('DRAFT_CONTENT_CHANGED', 'Draft file is corrupted');
  }
  const draft = value as Partial<Draft>;
  if (
    draft.version !== 1 ||
    draft.id !== draftId ||
    draft.accountId !== accountId ||
    (draft.status !== 'draft' && draft.status !== 'sent') ||
    typeof draft.subject !== 'string' ||
    (draft.text !== null && typeof draft.text !== 'string') ||
    (draft.html !== null && typeof draft.html !== 'string') ||
    (draft.inReplyTo !== null && typeof draft.inReplyTo !== 'string') ||
    (draft.replyToMessageId !== null && typeof draft.replyToMessageId !== 'string') ||
    !isAddressArray(draft.to) ||
    !isAddressArray(draft.cc) ||
    !isAddressArray(draft.bcc) ||
    !Array.isArray(draft.references) ||
    !draft.references.every((entry) => typeof entry === 'string') ||
    typeof draft.createdAt !== 'string' ||
    (draft.sentAt !== null && typeof draft.sentAt !== 'string') ||
    typeof draft.contentHash !== 'string'
  ) {
    throw new EmailMcpError('DRAFT_CONTENT_CHANGED', 'Draft file is corrupted or has an unsupported format');
  }
  const content: DraftContent = {
    accountId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    html: draft.html,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    replyToMessageId: draft.replyToMessageId,
  };
  const expected = computeDraftHash(content);
  if (expected !== draft.contentHash) {
    throw new EmailMcpError('DRAFT_CONTENT_CHANGED', 'Draft content was modified after creation');
  }
  return draft as Draft;
}

/**
 * Local draft storage. Drafts are never synced to the provider in v0.1.0.
 * Files are written atomically with 0600 permissions and are isolated by
 * account directory.
 */
export class DraftStore {
  private readonly draftsDir: string;
  private readonly now: () => Date;

  constructor(options: DraftStoreOptions) {
    this.draftsDir = join(options.dataDir, 'drafts');
    this.now = options.now ?? (() => new Date());
  }

  private accountDir(accountId: string): string {
    assertAccountId(accountId);
    return join(this.draftsDir, accountId);
  }

  private draftPath(accountId: string, draftId: string): string {
    assertDraftId(draftId);
    return join(this.accountDir(accountId), `${draftId}.json`);
  }

  private async ensureAccountDir(accountId: string): Promise<string> {
    const directory = this.accountDir(accountId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async writeDraft(accountId: string, draft: Draft): Promise<void> {
    const directory = await this.ensureAccountDir(accountId);
    const target = join(directory, `${draft.id}.json`);
    const temporary = join(directory, `.${draft.id}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async create(input: CreateDraftInput): Promise<Draft> {
    assertAccountId(input.accountId);
    if (input.to.length === 0) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'At least one recipient is required');
    }
    const content: DraftContent = {
      accountId: input.accountId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      replyToMessageId: input.replyToMessageId,
    };
    const draft: Draft = {
      version: 1,
      id: `drft_${randomBytes(12).toString('hex')}`,
      status: 'draft',
      createdAt: this.now().toISOString(),
      sentAt: null,
      contentHash: computeDraftHash(content),
      receipt: null,
      ...content,
    };
    await this.writeDraft(input.accountId, draft);
    return draft;
  }

  async get(accountId: string, draftId: string): Promise<Draft> {
    assertAccountId(accountId);
    const path = this.draftPath(accountId, draftId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EmailMcpError('DRAFT_NOT_FOUND', `Draft "${draftId}" was not found for account "${accountId}"`);
      }
      throw new EmailMcpError('INTERNAL_ERROR', 'Draft could not be read', { cause: error });
    }
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.maxDraftFileBytes) {
      throw new EmailMcpError('DRAFT_CONTENT_CHANGED', 'Draft file exceeds the size limit');
    }
    return parseDraft(raw, accountId, draftId);
  }

  async markSent(accountId: string, draftId: string, receipt: SendReceipt): Promise<Draft> {
    const draft = await this.get(accountId, draftId);
    if (draft.status === 'sent') {
      throw new EmailMcpError('DRAFT_ALREADY_SENT', 'Draft has already been sent');
    }
    const updated: Draft = {
      ...draft,
      status: 'sent',
      sentAt: receipt.sentAt,
      receipt,
    };
    await this.writeDraft(accountId, updated);
    return updated;
  }
}
