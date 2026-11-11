import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftStore, computeDraftHash } from '../../src/core/draft-store.js';
import { EmailMcpError } from '../../src/core/errors.js';

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

function draftInput(accountId = 'demo-a'): Parameters<DraftStore['create']>[0] {
  return {
    accountId,
    to: [{ address: 'alex@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Draft subject',
    text: 'Draft body',
    html: null,
    inReplyTo: null,
    references: [],
    replyToMessageId: null,
  };
}

describe('DraftStore', () => {
  let dataDir: string;
  let store: DraftStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'email-mcp-drafts-'));
    store = new DraftStore({ dataDir, now: () => new Date('2026-11-11T00:00:00.000Z') });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates drafts with a content hash and restrictive permissions', async () => {
    const draft = await store.create(draftInput());
    expect(draft.id).toMatch(/^drft_[a-f0-9]{24}$/);
    expect(draft.status).toBe('draft');
    expect(draft.contentHash).toBe(computeDraftHash(draft));

    const path = join(dataDir, 'drafts', 'demo-a', `${draft.id}.json`);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);

    const loaded = await store.get('demo-a', draft.id);
    expect(loaded.subject).toBe('Draft subject');
    expect(loaded.to).toEqual([{ address: 'alex@example.com' }]);
  });

  it('isolates drafts between accounts', async () => {
    const draft = await store.create(draftInput('demo-a'));
    await expectRejects(store.get('demo-b', draft.id), 'DRAFT_NOT_FOUND');
  });

  it('rejects invalid identifiers and empty recipient lists', async () => {
    await expectRejects(store.get('Demo A', `drft_${'a'.repeat(24)}`), 'INVALID_ARGUMENT');
    await expectRejects(store.get('demo-a', 'not-a-draft'), 'INVALID_ARGUMENT');
    await expectRejects(
      store.create({ ...draftInput(), to: [] }),
      'INVALID_ARGUMENT',
    );
  });

  it('detects draft content tampering', async () => {
    const draft = await store.create(draftInput());
    const path = join(dataDir, 'drafts', 'demo-a', `${draft.id}.json`);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    parsed['subject'] = 'Tampered subject';
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    await expectRejects(store.get('demo-a', draft.id), 'DRAFT_CONTENT_CHANGED');
  });

  it('marks drafts as sent exactly once', async () => {
    const draft = await store.create(draftInput());
    const sent = await store.markSent('demo-a', draft.id, {
      providerMessageId: '<sent@example.com>',
      accepted: ['alex@example.com'],
      rejected: [],
      response: '250 OK',
      partial: false,
      sentAt: '2026-11-11T00:05:00.000Z',
    });
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).toBe('2026-11-11T00:05:00.000Z');
    expect(sent.receipt?.accepted).toEqual(['alex@example.com']);

    await expectRejects(store.markSent('demo-a', draft.id, sent.receipt!), 'DRAFT_ALREADY_SENT');
  });

  it('reports missing drafts and corrupted files', async () => {
    await expectRejects(store.get('demo-a', `drft_${'c'.repeat(24)}`), 'DRAFT_NOT_FOUND');
    const draft = await store.create(draftInput());
    await writeFile(join(dataDir, 'drafts', 'demo-a', `${draft.id}.json`), '{invalid', { mode: 0o600 });
    await expectRejects(store.get('demo-a', draft.id), 'DRAFT_CONTENT_CHANGED');
  });
});
