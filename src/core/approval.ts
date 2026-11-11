import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_ID_PATTERN, DRAFT_ID_PATTERN } from '../config/schema.js';
import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';

export interface ApprovalRecord {
  tokenHash: string;
  accountId: string;
  draftId: string;
  contentHash: string;
  createdAt: string;
  expiresAt: string;
  approvedBy: string;
  usedAt: string | null;
}

interface ApprovalLedger {
  version: 1;
  approvals: ApprovalRecord[];
}

export interface ApprovalServiceOptions {
  dataDir: string;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  now?: () => Date;
  logger?: Logger;
}

export interface MintApprovalInput {
  accountId: string;
  draftId: string;
  contentHash: string;
  approvedBy: string;
  ttlSeconds?: number;
}

export interface MintedApproval {
  token: string;
  expiresAt: string;
}

export interface ConsumeApprovalInput {
  token: string;
  accountId: string;
  draftId: string;
  contentHash: string;
}

const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Single-use, out-of-band approval tokens. Tokens are minted by a human-operated
 * CLI, never by an MCP tool, and are bound to one account, one draft, and the
 * exact draft content hash.
 */
export class ApprovalService {
  private readonly dataDir: string;
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly defaultTtlSeconds: number;
  private readonly maxTtlSeconds: number;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(options: ApprovalServiceOptions) {
    this.dataDir = options.dataDir;
    this.ledgerPath = join(this.dataDir, 'approvals.json');
    this.lockPath = `${this.ledgerPath}.lock`;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? LIMITS.defaultApprovalTtlSeconds;
    this.maxTtlSeconds = options.maxTtlSeconds ?? LIMITS.maxApprovalTtlSeconds;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger();
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await open(this.lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new EmailMcpError('INTERNAL_ERROR', 'Approval ledger lock could not be created', { cause: error });
        }
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > 10_000) {
            await unlink(this.lockPath);
            continue;
          }
        } catch {
          continue;
        }
        await delay(10);
      }
    }
    if (handle === undefined) {
      throw new EmailMcpError('INTERNAL_ERROR', 'Timed out waiting for the approval ledger lock', {
        retryable: true,
      });
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async readLedger(): Promise<ApprovalLedger> {
    let raw: string;
    try {
      raw = await readFile(this.ledgerPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, approvals: [] };
      }
      throw new EmailMcpError('INTERNAL_ERROR', 'Approval ledger could not be read', { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EmailMcpError('SECURITY_BLOCKED', 'Approval ledger is corrupted; refusing to continue');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ApprovalLedger).version !== 1 ||
      !Array.isArray((parsed as ApprovalLedger).approvals)
    ) {
      throw new EmailMcpError('SECURITY_BLOCKED', 'Approval ledger has an unsupported format; refusing to continue');
    }
    const approvals = (parsed as ApprovalLedger).approvals;
    for (const record of approvals) {
      if (
        typeof record !== 'object' ||
        record === null ||
        typeof record.tokenHash !== 'string' ||
        !TOKEN_HASH_PATTERN.test(record.tokenHash) ||
        typeof record.accountId !== 'string' ||
        typeof record.draftId !== 'string' ||
        typeof record.contentHash !== 'string' ||
        typeof record.createdAt !== 'string' ||
        typeof record.expiresAt !== 'string' ||
        typeof record.approvedBy !== 'string' ||
        (record.usedAt !== null && typeof record.usedAt !== 'string')
      ) {
        throw new EmailMcpError('SECURITY_BLOCKED', 'Approval ledger contains an invalid record; refusing to continue');
      }
    }
    return { version: 1, approvals };
  }

  private async writeLedger(ledger: ApprovalLedger): Promise<void> {
    const cutoff = this.now().getTime() - 24 * 60 * 60 * 1000;
    const approvals = ledger.approvals
      .filter((record) => {
        if (record.usedAt !== null) {
          return Date.parse(record.usedAt) >= cutoff;
        }
        return Date.parse(record.expiresAt) >= cutoff;
      })
      .slice(-500);
    const temporary = join(this.dataDir, `.approvals.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, approvals }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.ledgerPath);
  }

  async mint(input: MintApprovalInput): Promise<MintedApproval> {
    if (!ACCOUNT_ID_PATTERN.test(input.accountId)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'account_id has an invalid format');
    }
    if (!DRAFT_ID_PATTERN.test(input.draftId)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'draft_id has an invalid format');
    }
    if (!TOKEN_HASH_PATTERN.test(input.contentHash)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'content hash is invalid');
    }
    const approvedBy = input.approvedBy.trim();
    // eslint-disable-next-line no-control-regex
    if (approvedBy.length === 0 || approvedBy.length > 100 || /[\u0000-\u001F\u007F]/.test(approvedBy)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'approvedBy must be a short, printable identifier');
    }
    const ttlSeconds = input.ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > this.maxTtlSeconds) {
      throw new EmailMcpError('INVALID_ARGUMENT', `ttlSeconds must be between 1 and ${this.maxTtlSeconds}`);
    }

    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const record: ApprovalRecord = {
      tokenHash: hashToken(token),
      accountId: input.accountId,
      draftId: input.draftId,
      contentHash: input.contentHash,
      createdAt: now.toISOString(),
      expiresAt,
      approvedBy,
      usedAt: null,
    };

    await this.withLock(async () => {
      const ledger = await this.readLedger();
      ledger.approvals.push(record);
      await this.writeLedger(ledger);
    });

    this.logger.info('approval_minted', {
      account_id: input.accountId,
      draft_id: input.draftId,
      approved_by: approvedBy,
      expires_at: expiresAt,
    });

    return { token, expiresAt };
  }

  async consume(input: ConsumeApprovalInput): Promise<ApprovalRecord> {
    if (typeof input.token !== 'string' || input.token.length < 20 || input.token.length > 200) {
      throw new EmailMcpError('APPROVAL_INVALID', 'Approval token is not valid');
    }
    if (!ACCOUNT_ID_PATTERN.test(input.accountId) || !DRAFT_ID_PATTERN.test(input.draftId)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'Invalid account or draft identifier');
    }
    const presentedHash = hashToken(input.token);
    return this.withLock(async () => {
      const ledger = await this.readLedger();
      const now = this.now().toISOString();
      let matched: ApprovalRecord | undefined;
      for (const record of ledger.approvals) {
        if (constantTimeEqualHex(record.tokenHash, presentedHash)) {
          matched = record;
          break;
        }
      }
      if (matched === undefined) {
        throw new EmailMcpError('APPROVAL_INVALID', 'Approval token is not valid');
      }
      if (matched.usedAt !== null) {
        throw new EmailMcpError('APPROVAL_ALREADY_USED', 'Approval token has already been used');
      }
      if (Date.parse(matched.expiresAt) <= this.now().getTime()) {
        throw new EmailMcpError('APPROVAL_EXPIRED', 'Approval token has expired');
      }
      if (
        matched.accountId !== input.accountId ||
        matched.draftId !== input.draftId ||
        !constantTimeEqualHex(matched.contentHash, input.contentHash)
      ) {
        throw new EmailMcpError('APPROVAL_INVALID', 'Approval token is not valid for this draft');
      }
      matched.usedAt = now;
      await this.writeLedger(ledger);
      this.logger.info('approval_consumed', {
        account_id: input.accountId,
        draft_id: input.draftId,
      });
      return matched;
    });
  }
}
