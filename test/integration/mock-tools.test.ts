import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailMcpError } from '../../src/core/errors.js';
import type { Draft } from '../../src/core/draft-store.js';
import { encodeMessageRef } from '../../src/core/message-ref.js';
import { createMockHarness, type MockHarness } from '../helpers/harness.js';

async function expectRejects(promise: Promise<unknown>, code: string): Promise<EmailMcpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMcpError);
    expect((error as EmailMcpError).code).toBe(code);
    return error as EmailMcpError;
  }
  throw new Error(`Expected EmailMcpError with code ${code}`);
}

function messages(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return result['messages'] as Array<Record<string, unknown>>;
}

function draftOf(result: Record<string, unknown>): Record<string, unknown> {
  return result['draft'] as Record<string, unknown>;
}

async function createDraft(harness: MockHarness, overrides: Record<string, unknown> = {}): Promise<Draft> {
  const result = await harness.tools.createDraft({
    account_id: 'demo-a',
    to: ['alex@example.com'],
    subject: 'Hello from the test suite',
    text: 'This draft is stored locally.',
    ...overrides,
  });
  const draft = draftOf(result);
  return harness.drafts.get('demo-a', draft['draft_id'] as string);
}

describe('mock multi-account tools', () => {
  let harness: MockHarness;

  beforeEach(async () => {
    harness = await createMockHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('lists two accounts without exposing credentials', async () => {
    const result = await harness.tools.listAccounts();
    const accounts = result['accounts'] as Array<Record<string, unknown>>;
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account['account_id'])).toEqual(['demo-a', 'demo-b']);
    expect(accounts.every((account) => account['provider'] === 'mock')).toBe(true);
    expect(accounts.map((account) => account['verification_status'])).toEqual([
      'not-applicable',
      'not-applicable',
    ]);
    expect(result['send_policy']).toMatchObject({
      global_send_enabled: false,
      approval_required: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('username');
  });

  it('lists folders per account', async () => {
    const result = await harness.tools.listFolders({ account_id: 'demo-a' });
    const folders = result['folders'] as Array<Record<string, unknown>>;
    expect(folders.map((folder) => folder['path'])).toEqual(['INBOX', 'Sent', 'Drafts', 'Archive']);
  });

  it('paginates messages with cursors and no duplicates', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result: Record<string, unknown> = await harness.tools.listMessages({
        account_id: 'demo-a',
        folder: 'INBOX',
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const pageMessages = messages(result);
      seen.push(...pageMessages.map((message) => message['uid'] as number));
      const next = result['next_cursor'];
      cursor = next === null ? undefined : (next as string);
      if (cursor === undefined) {
        break;
      }
    }
    expect(seen).toEqual([105, 104, 103, 102, 101]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('filters unread messages', async () => {
    const result = await harness.tools.listMessages({
      account_id: 'demo-a',
      folder: 'INBOX',
      limit: 20,
      unread_only: true,
    });
    expect(messages(result).map((message) => message['uid'])).toEqual([105, 104, 103]);
  });

  it('searches subjects and bodies case-insensitively', async () => {
    const result = await harness.tools.searchMessages({
      account_id: 'demo-a',
      query: 'INVOICE',
      limit: 20,
    });
    expect(messages(result).map((message) => message['uid'])).toEqual([104]);
  });

  it('applies date bounds to searches', async () => {
    const since = await harness.tools.searchMessages({
      account_id: 'demo-a',
      query: 'e',
      since: '2026-11-03',
      limit: 20,
    });
    expect(messages(since).map((message) => message['uid'])).toEqual([105, 104]);

    const before = await harness.tools.searchMessages({
      account_id: 'demo-a',
      query: 'e',
      before: '2026-11-03',
      limit: 20,
    });
    expect(messages(before).map((message) => message['uid'])).toEqual([103, 102, 101]);
  });

  it('isolates account contents even when UIDs collide', async () => {
    const demoA = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const demoB = await harness.tools.listMessages({ account_id: 'demo-b', folder: 'INBOX', limit: 20 });

    const subjectsA = messages(demoA).map((message) => message['subject']);
    const subjectsB = messages(demoB).map((message) => message['subject']);
    expect(subjectsA).toHaveLength(5);
    expect(subjectsB).toEqual(['Vendor contract review', "Blair's private inbox"]);
    expect(subjectsA).not.toEqual(expect.arrayContaining(subjectsB));

    // UID 101 exists in both accounts. Reading via demo-b must never reveal demo-a content.
    const demoAWelcome = messages(demoA).find((message) => message['uid'] === 101)?.['message_id'] as string;
    const crossRead = await harness.tools.getMessage({ account_id: 'demo-b', message_id: demoAWelcome });
    const detail = crossRead['message'] as Record<string, unknown>;
    expect(detail['subject']).toBe("Blair's private inbox");
    expect(detail['subject']).not.toBe('Welcome to the demo mailbox');
  });

  it('rejects account, folder, and cursor violations', async () => {
    await expectRejects(harness.tools.listFolders({ account_id: 'missing' }), 'UNKNOWN_ACCOUNT');
    await expectRejects(harness.tools.listFolders({ account_id: 'Demo A' }), 'INVALID_ARGUMENT');
    await expectRejects(
      harness.tools.listMessages({ account_id: 'demo-a', folder: 'NoSuchFolder', limit: 10 }),
      'FOLDER_NOT_FOUND',
    );
    await expectRejects(
      harness.tools.listMessages({ account_id: 'demo-a', cursor: 'garbage', limit: 10 }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX/../Sent', limit: 10 }),
      'INVALID_ARGUMENT',
    );
  });

  it('validates search input to block header injection', async () => {
    await expectRejects(
      harness.tools.searchMessages({ account_id: 'demo-a', query: 'invoice\r\nBcc: x@example.com' }),
      'HEADER_INJECTION_BLOCKED',
    );
    await expectRejects(
      harness.tools.searchMessages({ account_id: 'demo-a', query: 'invoice', since: '2026-11-05', before: '2026-11-01' }),
      'INVALID_ARGUMENT',
    );
  });

  it('returns message detail with untrusted-content marking and sanitized HTML', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const invoiceId = messages(list).find((message) => message['uid'] === 104)?.['message_id'] as string;

    const withoutHtml = await harness.tools.getMessage({ account_id: 'demo-a', message_id: invoiceId });
    const plain = withoutHtml['message'] as Record<string, unknown>;
    expect(plain['subject']).toBe('Invoice INV-2041');
    expect(plain['content_trust']).toBe('untrusted-external');
    expect(plain['html']).toBeNull();
    expect(plain['attachments']).toEqual([
      expect.objectContaining({ filename: 'INV-2041.pdf', content_type: 'application/pdf' }),
    ]);

    const withHtml = await harness.tools.getMessage({
      account_id: 'demo-a',
      message_id: invoiceId,
      include_html: true,
    });
    const rich = withHtml['message'] as Record<string, unknown>;
    expect(String(rich['html'])).toContain('INV-2041');
    expect(String(rich['html'])).not.toContain('<script');
  });

  it('supports body truncation and folder hints', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const welcomeId = messages(list).find((message) => message['uid'] === 101)?.['message_id'] as string;

    const result = await harness.tools.getMessage({
      account_id: 'demo-a',
      message_id: welcomeId,
      folder: 'INBOX',
      max_body_chars: 10,
    });
    const detail = result['message'] as Record<string, unknown>;
    expect(detail['truncated']).toBe(true);
    expect(String(detail['text']).length).toBeLessThanOrEqual(10);

    await expectRejects(
      harness.tools.getMessage({ account_id: 'demo-a', message_id: welcomeId, folder: 'Sent' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      harness.tools.getMessage({ account_id: 'demo-a', message_id: 'imap1.QQ.1.1' }),
      'INVALID_ARGUMENT',
    );
  });

  it('builds best-effort threads from message headers', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const kickoffId = messages(list).find((message) => message['uid'] === 102)?.['message_id'] as string;

    const result = await harness.tools.getThread({ account_id: 'demo-a', message_id: kickoffId });
    const thread = result['thread'] as Record<string, unknown>;
    expect(thread['complete']).toBe(false);
    expect(thread['method']).toBe('references');
    expect((thread['messages'] as Array<Record<string, unknown>>).map((message) => message['uid'])).toEqual([
      102, 103,
    ]);
  });

  it('creates local drafts without sending or writing provider drafts', async () => {
    const result = await harness.tools.createDraft({
      account_id: 'demo-a',
      to: ['Alex Example <alex@example.com>', 'blair@example.org'],
      cc: ['team@example.com'],
      subject: 'Quarterly plan',
      text: 'Draft body',
      html: '<p>Draft body</p>',
    });
    expect(result['send_instructions']).toContain('NOT sent');
    const draft = draftOf(result);
    expect(draft['status']).toBe('local_draft');
    expect(draft['has_text']).toBe(true);
    expect(draft['has_html']).toBe(true);

    const stored = await harness.drafts.get('demo-a', draft['draft_id'] as string);
    expect(stored.status).toBe('draft');
    expect(harness.mockProvider('demo-a').getOutbox()).toHaveLength(0);
    expect(await harness.tools.listFolders({ account_id: 'demo-a' })).toBeTruthy();
    const folders = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'Drafts', limit: 20 });
    expect(messages(folders)).toHaveLength(0);
  });

  it('rejects invalid drafts', async () => {
    await expectRejects(
      harness.tools.createDraft({ account_id: 'demo-a', to: ['not-an-address'], subject: 'X', text: 'body' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      harness.tools.createDraft({
        account_id: 'demo-a',
        to: ['alex@example.com'],
        subject: 'Hello\r\nBcc: victim@example.com',
        text: 'body',
      }),
      'HEADER_INJECTION_BLOCKED',
    );
    await expectRejects(
      harness.tools.createDraft({ account_id: 'demo-a', to: ['alex@example.com'], subject: 'X' }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      harness.tools.createDraft({
        account_id: 'demo-a',
        to: ['alex@example.com'],
        subject: 'X',
        text: 'body',
        in_reply_to: 'not-a-message-id',
      }),
      'INVALID_ARGUMENT',
    );
  });

  it('denies sending while the global switch is off', async () => {
    const draft = await createDraft(harness);
    const result = await expectRejects(
      harness.tools.sendDraft({ account_id: 'demo-a', draft_id: draft.id, approval_token: 'x'.repeat(43) }),
      'SEND_DISABLED',
    );
    expect(result.message).toContain('EMAIL_ENABLE_SEND');
    expect(harness.mockProvider('demo-a').getOutbox()).toHaveLength(0);
    expect((await harness.drafts.get('demo-a', draft.id)).status).toBe('draft');
  });

  it('requires an approval token even when sending is enabled', async () => {
    const enabled = await createMockHarness({ globalSendEnabled: true });
    try {
      const draft = await createDraft(enabled);
      const result = await expectRejects(
        enabled.tools.sendDraft({ account_id: 'demo-a', draft_id: draft.id, approval_token: '' }),
        'APPROVAL_REQUIRED',
      );
      expect(result).toBeInstanceOf(EmailMcpError);
      expect(enabled.mockProvider('demo-a').getOutbox()).toHaveLength(0);
    } finally {
      await enabled.cleanup();
    }
  });

  it('sends a draft only after a human approval token is consumed', async () => {
    const enabled = await createMockHarness({ globalSendEnabled: true });
    try {
      const draft = await createDraft(enabled, {
        to: ['alex@example.com'],
        cc: ['blair@example.org'],
        subject: 'Approved message',
        text: 'Approved body',
      });
      const approval = await enabled.approvals.mint({
        accountId: 'demo-a',
        draftId: draft.id,
        contentHash: draft.contentHash,
        approvedBy: 'alice',
      });

      const result = await enabled.tools.sendDraft({
        account_id: 'demo-a',
        draft_id: draft.id,
        approval_token: approval.token,
      });
      expect(result['status']).toBe('sent');
      expect(result['draft_state_updated']).toBe(true);
      const receipt = result['receipt'] as Record<string, unknown>;
      expect(receipt['accepted']).toEqual(['alex@example.com', 'blair@example.org']);
      expect(receipt['partial']).toBe(false);

      const outbox = enabled.mockProvider('demo-a').getOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.envelope.subject).toBe('Approved message');
      expect(outbox[0]?.envelope.text).toBe('Approved body');
      expect((await enabled.drafts.get('demo-a', draft.id)).status).toBe('sent');

      await expectRejects(
        enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        }),
        'DRAFT_ALREADY_SENT',
      );
      expect(enabled.mockProvider('demo-a').getOutbox()).toHaveLength(1);
    } finally {
      await enabled.cleanup();
    }
  });

  it('rejects forged, reused, and cross-draft approval tokens', async () => {
    const enabled = await createMockHarness({ globalSendEnabled: true });
    try {
      const draft = await createDraft(enabled);
      const otherDraft = await createDraft(enabled, { subject: 'Other draft' });
      await expectRejects(
        enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: 'A'.repeat(43),
        }),
        'APPROVAL_INVALID',
      );

      const otherApproval = await enabled.approvals.mint({
        accountId: 'demo-a',
        draftId: otherDraft.id,
        contentHash: otherDraft.contentHash,
        approvedBy: 'alice',
      });
      await expectRejects(
        enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: otherApproval.token,
        }),
        'APPROVAL_INVALID',
      );
      expect(enabled.mockProvider('demo-a').getOutbox()).toHaveLength(0);
    } finally {
      await enabled.cleanup();
    }
  });

  it('enforces the recipient allowlist', async () => {
    const enabled = await createMockHarness({
      globalSendEnabled: true,
      allowlist: ['@example.com'],
    });
    try {
      const draft = await createDraft(enabled, { to: ['eve@evil.example'] });
      const approval = await enabled.approvals.mint({
        accountId: 'demo-a',
        draftId: draft.id,
        contentHash: draft.contentHash,
        approvedBy: 'alice',
      });
      const error = await expectRejects(
        enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        }),
        'RECIPIENT_NOT_ALLOWED',
      );
      expect(error.details).toEqual({ recipient: 'eve@evil.example' });
      expect(enabled.mockProvider('demo-a').getOutbox()).toHaveLength(0);
    } finally {
      await enabled.cleanup();
    }
  });

  it('enforces the send rate limit per account', async () => {
    const enabled = await createMockHarness({ globalSendEnabled: true, rateLimitPerMinute: 1 });
    try {
      for (let index = 0; index < 2; index += 1) {
        const draft = await createDraft(enabled, { subject: `Rate limit ${index}` });
        const approval = await enabled.approvals.mint({
          accountId: 'demo-a',
          draftId: draft.id,
          contentHash: draft.contentHash,
          approvedBy: 'alice',
        });
        const send = enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        });
        if (index === 0) {
          await expect(send).resolves.toMatchObject({ status: 'sent' });
        } else {
          await expectRejects(send, 'RATE_LIMITED');
        }
      }
      expect(enabled.mockProvider('demo-a').getOutbox()).toHaveLength(1);
    } finally {
      await enabled.cleanup();
    }
  });

  it('keeps approval tokens single-use when the provider fails', async () => {
    const failing = await createMockHarness({
      globalSendEnabled: true,
      sendFailures: { 'demo-a': 'authentication' },
    });
    try {
      const draft = await createDraft(failing);
      const approval = await failing.approvals.mint({
        accountId: 'demo-a',
        draftId: draft.id,
        contentHash: draft.contentHash,
        approvedBy: 'alice',
      });
      await expectRejects(
        failing.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        }),
        'AUTHENTICATION_FAILED',
      );
      expect(failing.mockProvider('demo-a').getOutbox()).toHaveLength(0);
      expect((await failing.drafts.get('demo-a', draft.id)).status).toBe('draft');

      await expectRejects(
        failing.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        }),
        'APPROVAL_ALREADY_USED',
      );
    } finally {
      await failing.cleanup();
    }
  });

  it('maps mock connection and rejection failures to stable error codes', async () => {
    for (const [failure, code] of [
      ['connection', 'CONNECTION_FAILED'],
      ['rejected', 'SMTP_SEND_FAILED'],
    ] as const) {
      const failing = await createMockHarness({
        globalSendEnabled: true,
        sendFailures: { 'demo-a': failure },
      });
      try {
        const draft = await createDraft(failing);
        const approval = await failing.approvals.mint({
          accountId: 'demo-a',
          draftId: draft.id,
          contentHash: draft.contentHash,
          approvedBy: 'alice',
        });
        await expectRejects(
          failing.tools.sendDraft({
            account_id: 'demo-a',
            draft_id: draft.id,
            approval_token: approval.token,
          }),
          code,
        );
      } finally {
        await failing.cleanup();
      }
    }
  });

  it('denies sending for an account disabled in configuration', async () => {
    const enabled = await createMockHarness({
      globalSendEnabled: true,
      accountSendEnabled: false,
    });
    try {
      const draft = await createDraft(enabled);
      const approval = await enabled.approvals.mint({
        accountId: 'demo-a',
        draftId: draft.id,
        contentHash: draft.contentHash,
        approvedBy: 'alice',
      });
      await expectRejects(
        enabled.tools.sendDraft({
          account_id: 'demo-a',
          draft_id: draft.id,
          approval_token: approval.token,
        }),
        'SEND_DISABLED',
      );
    } finally {
      await enabled.cleanup();
    }
  });

  it('creates reply drafts with correct threading headers and never sends', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const kickoffId = messages(list).find((message) => message['uid'] === 102)?.['message_id'] as string;

    const result = await harness.tools.reply({
      account_id: 'demo-a',
      message_id: kickoffId,
      text: 'Thursday works for me.',
    });
    expect(result['sent']).toBe(false);
    const reply = result['reply'] as Record<string, unknown>;
    expect(reply['subject']).toBe('Re: Project kickoff');
    expect(reply['in_reply_to']).toBe('<demo-a-kickoff@example.org>');
    expect(reply['references']).toEqual(['<demo-a-kickoff@example.org>']);
    expect(reply['to']).toEqual([{ name: 'Blair Chen', address: 'blair@example.org' }]);

    const draft = draftOf(result);
    const stored = await harness.drafts.get('demo-a', draft['draft_id'] as string);
    expect(stored.inReplyTo).toBe('<demo-a-kickoff@example.org>');
    expect(stored.references).toEqual(['<demo-a-kickoff@example.org>']);
    expect(stored.replyToMessageId).toBe(kickoffId);
    expect(harness.mockProvider('demo-a').getOutbox()).toHaveLength(0);
  });

  it('supports reply-all without duplicating the account or primary recipient', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const invoiceId = messages(list).find((message) => message['uid'] === 104)?.['message_id'] as string;

    const result = await harness.tools.reply({
      account_id: 'demo-a',
      message_id: invoiceId,
      text: 'Thanks, reviewing now.',
      reply_all: true,
    });
    const reply = result['reply'] as Record<string, unknown>;
    expect(reply['to']).toEqual([{ name: 'Vendor Billing', address: 'billing@vendor.example' }]);
    expect(reply['cc']).toEqual([{ name: null, address: 'finance@example.com' }]);
  });

  it('validates reply input and missing originals', async () => {
    const list = await harness.tools.listMessages({ account_id: 'demo-a', folder: 'INBOX', limit: 20 });
    const kickoffId = messages(list).find((message) => message['uid'] === 102)?.['message_id'] as string;
    await expectRejects(
      harness.tools.reply({ account_id: 'demo-a', message_id: kickoffId }),
      'INVALID_ARGUMENT',
    );
    await expectRejects(
      harness.tools.reply({
        account_id: 'demo-a',
        message_id: encodeMessageRef('mock1', 'INBOX', '1', 999),
        text: 'hi',
      }),
      'MESSAGE_NOT_FOUND',
    );
    await expectRejects(
      harness.tools.reply({
        account_id: 'demo-a',
        message_id: kickoffId,
        text: 'hi',
        folder: 'Sent',
      }),
      'INVALID_ARGUMENT',
    );
  });
});
