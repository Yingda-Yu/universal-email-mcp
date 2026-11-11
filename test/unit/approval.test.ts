import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/core/approval.js';
import { EmailMcpError } from '../../src/core/errors.js';

const ACCOUNT = 'demo-a';
const DRAFT_A = `drft_${'a'.repeat(24)}`;
const DRAFT_B = `drft_${'b'.repeat(24)}`;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function expectRejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMcpError);
    expect((error as EmailMcpError).code).toBe(code);
    return;
  }
  throw new Error(`Expected EmailMcpError with code ${code}`);
}

describe('ApprovalService', () => {
  let dataDir: string;
  let now: Date;
  let approvals: ApprovalService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'email-mcp-approval-'));
    now = new Date('2026-11-11T00:00:00.000Z');
    approvals = new ApprovalService({
      dataDir,
      now: () => now,
      defaultTtlSeconds: 900,
      maxTtlSeconds: 3_600,
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('mints a single-use token and stores only its hash', async () => {
    const minted = await approvals.mint({
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
      approvedBy: 'alice',
    });
    expect(minted.token.length).toBeGreaterThan(20);
    expect(minted.expiresAt).toBe('2026-11-11T00:15:00.000Z');

    const ledger = await readFile(join(dataDir, 'approvals.json'), 'utf8');
    expect(ledger).not.toContain(minted.token);
    expect(ledger).toContain(minted.token === '' ? 'never' : 'tokenHash');

    const record = await approvals.consume({
      token: minted.token,
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
    });
    expect(record.approvedBy).toBe('alice');
    expect(record.usedAt).toBe(now.toISOString());
  });

  it('rejects reuse of a consumed token', async () => {
    const minted = await approvals.mint({
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
      approvedBy: 'alice',
    });
    await approvals.consume({
      token: minted.token,
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
    });
    await expectRejects(
      approvals.consume({
        token: minted.token,
        accountId: ACCOUNT,
        draftId: DRAFT_A,
        contentHash: HASH_A,
      }),
      'APPROVAL_ALREADY_USED',
    );
  });

  it('binds tokens to the account, draft, and exact content hash', async () => {
    const minted = await approvals.mint({
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
      approvedBy: 'alice',
    });
    await expectRejects(
      approvals.consume({
        token: minted.token,
        accountId: ACCOUNT,
        draftId: DRAFT_B,
        contentHash: HASH_A,
      }),
      'APPROVAL_INVALID',
    );
    await expectRejects(
      approvals.consume({
        token: minted.token,
        accountId: 'demo-b',
        draftId: DRAFT_A,
        contentHash: HASH_A,
      }),
      'APPROVAL_INVALID',
    );
    await expectRejects(
      approvals.consume({
        token: minted.token,
        accountId: ACCOUNT,
        draftId: DRAFT_A,
        contentHash: HASH_B,
      }),
      'APPROVAL_INVALID',
    );
  });

  it('rejects expired tokens', async () => {
    const minted = await approvals.mint({
      accountId: ACCOUNT,
      draftId: DRAFT_A,
      contentHash: HASH_A,
      approvedBy: 'alice',
      ttlSeconds: 60,
    });
    now = new Date('2026-11-11T00:01:01.000Z');
    await expectRejects(
      approvals.consume({
        token: minted.token,
        accountId: ACCOUNT,
        draftId: DRAFT_A,
        contentHash: HASH_A,
      }),
      'APPROVAL_EXPIRED',
    );
  });

  it('validates token inputs and ttl bounds', async () => {
    await expectRejects(
      approvals.mint({ accountId: ACCOUNT, draftId: DRAFT_A, contentHash: HASH_A, approvedBy: '   ' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      approvals.mint({
        accountId: ACCOUNT,
        draftId: DRAFT_A,
        contentHash: HASH_A,
        approvedBy: 'alice',
        ttlSeconds: 3_601,
      }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      approvals.consume({ token: 'short', accountId: ACCOUNT, draftId: DRAFT_A, contentHash: HASH_A }),
      'APPROVAL_INVALID',
    );
  });

  it('fails closed when the ledger is corrupted', async () => {
    await writeFile(join(dataDir, 'approvals.json'), '{not json', { mode: 0o600 });
    await expectRejects(
      approvals.consume({ token: 'x'.repeat(40), accountId: ACCOUNT, draftId: DRAFT_A, contentHash: HASH_A }),
      'SECURITY_BLOCKED',
    );
  });

  it('validates identifiers before touching the ledger', async () => {
    await expectRejects(
      approvals.mint({ accountId: 'Demo A', draftId: DRAFT_A, contentHash: HASH_A, approvedBy: 'alice' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      approvals.mint({ accountId: ACCOUNT, draftId: 'draft-1', contentHash: HASH_A, approvedBy: 'alice' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      approvals.mint({ accountId: ACCOUNT, draftId: DRAFT_A, contentHash: 'short', approvedBy: 'alice' }),
      'INVALID_ARGUMENT',
    );
  });
});
