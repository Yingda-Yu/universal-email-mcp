import { afterEach, describe, expect, it } from 'vitest';
import { EmailMcpError } from '../../src/core/errors.js';
import type { ResolvedAccountConfig } from '../../src/core/types.js';
import { FakeImapTransport } from '../helpers/fake-imap.js';
import { buildRawEmail } from '../helpers/raw-email.js';
import { encodeMessageRef } from '../../src/core/message-ref.js';
import { ImapSmtpProvider } from '../../src/providers/imap-smtp/provider.js';
import { SmtpSender } from '../../src/providers/imap-smtp/smtp-sender.js';
import type { SmtpEnvelope, SmtpResult, SmtpTransport } from '../../src/providers/imap-smtp/smtp-transport.js';

function account(overrides: Partial<ResolvedAccountConfig> = {}): ResolvedAccountConfig {
  return {
    id: 'corp-a',
    label: 'Corporate A',
    email: 'alice@corp.example',
    provider: 'imap-smtp',
    preset: 'netease-enterprise',
    username: 'alice@corp.example',
    password: 'secret',
    imap: { host: 'imap.qiye.163.com', port: 993, secure: true, requireTls: true },
    smtp: { host: 'smtp.qiye.163.com', port: 465, secure: true, requireTls: true },
    enabled: true,
    sendEnabled: true,
    mockFixture: null,
    verificationStatus: 'documented',
    ...overrides,
  };
}

function fixtureTransport(): FakeImapTransport {
  return new FakeImapTransport([
    {
      path: 'INBOX',
      uidValidity: '777',
      messages: [
        {
          uid: 10,
          source: buildRawEmail({
            subject: 'Older invoice',
            date: 'Tue, 03 Nov 2026 08:00:00 +0000',
            messageId: '<older@vendor.example>',
            text: 'Invoice INV-1000 is attached.',
          }),
          flags: ['\\Seen'],
        },
        {
          uid: 12,
          source: buildRawEmail({
            subject: 'Re: Project kickoff',
            date: 'Wed, 04 Nov 2026 10:00:00 +0000',
            messageId: '<reply@example.org>',
            inReplyTo: '<kickoff@example.org>',
            references: ['<kickoff@example.org>'],
            text: 'Thursday works for me.',
            html: '<p>Thursday <strong>works</strong></p><script>alert(1)</script>',
          }),
        },
        {
          uid: 11,
          source: buildRawEmail({
            subject: 'Project kickoff',
            date: 'Wed, 04 Nov 2026 09:00:00 +0000',
            messageId: '<kickoff@example.org>',
            text: 'Can we review the milestones?',
          }),
        },
      ],
    },
    {
      path: 'Archive',
      uidValidity: '888',
      messages: [
        {
          uid: 20,
          source: buildRawEmail({
            subject: 'Archived newsletter',
            date: 'Mon, 02 Nov 2026 09:00:00 +0000',
            messageId: '<newsletter@example.com>',
            text: 'Monthly roundup.',
          }),
        },
      ],
    },
  ]);
}

class FakeSmtpTransport implements SmtpTransport {
  readonly envelopes: SmtpEnvelope[] = [];
  constructor(private readonly result: SmtpResult) {}
  async send(envelope: SmtpEnvelope): Promise<SmtpResult> {
    this.envelopes.push(envelope);
    return this.result;
  }
  async close(): Promise<void> {
    // No-op fake.
  }
}

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

describe('ImapSmtpProvider with a fake transport', () => {
  const transports: FakeImapTransport[] = [];

  function makeProvider(options: {
    imap?: FakeImapTransport;
    smtp?: FakeSmtpTransport | null;
    config?: Partial<ResolvedAccountConfig>;
  } = {}): { provider: ImapSmtpProvider; imap: FakeImapTransport } {
    const imap = options.imap ?? fixtureTransport();
    transports.push(imap);
    const smtpSender =
      options.smtp === undefined
        ? null
        : options.smtp === null
          ? null
          : new SmtpSender(account(options.config), options.smtp);
    return {
      provider: new ImapSmtpProvider({
        config: account(options.config),
        imap,
        smtpSender,
      }),
      imap,
    };
  }

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.close()));
  });

  it('lists mailboxes and parses MIME summaries with pagination', async () => {
    const { provider } = makeProvider();
    const folders = await provider.listFolders();
    expect(folders.map((folder) => folder.path)).toEqual(['INBOX', 'Archive']);

    const firstPage = await provider.listMessages({ folder: 'INBOX', limit: 2 });
    expect(firstPage.items.map((message) => message.uid)).toEqual([12, 11]);
    expect(firstPage.items[0]?.subject).toBe('Re: Project kickoff');
    expect(firstPage.items[0]?.snippet).toContain('Thursday works for me.');
    expect(firstPage.items[0]?.messageId.startsWith('imap1.')).toBe(true);
    expect(firstPage.items[0]?.uidValidity).toBe('777');
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await provider.listMessages({
      folder: 'INBOX',
      limit: 2,
      cursor: firstPage.nextCursor as string,
    });
    expect(secondPage.items.map((message) => message.uid)).toEqual([10]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('passes server-side search criteria and paginates UIDs', async () => {
    const { provider, imap } = makeProvider();
    const page = await provider.searchMessages({
      folder: 'INBOX',
      query: 'INVOICE',
      since: '2026-11-01',
      before: '2026-11-10',
      limit: 5,
    });
    expect(page.items.map((message) => message.uid)).toEqual([10]);
    expect(page.nextCursor).toBeNull();
    expect(imap.searchRequests[0]?.query).toBe('INVOICE');
    expect(imap.searchRequests[0]?.since?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(imap.searchRequests[0]?.before?.toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('omits HTML unless requested and sanitizes it when requested', async () => {
    const { provider } = makeProvider();
    const messageId = encodeMessageRef('imap1', 'INBOX', '777', 12);

    const plain = await provider.getMessage(messageId, { includeHtml: false, maxBodyChars: 20_000 });
    expect(plain.html).toBeNull();
    expect(plain.warnings).toContain('html_not_requested');
    expect(plain.contentTrust).toBe('untrusted-external');

    const rich = await provider.getMessage(messageId, { includeHtml: true, maxBodyChars: 20_000 });
    expect(rich.html).toContain('<strong>works</strong>');
    expect(rich.html).not.toContain('<script');
  });

  it('rejects stale UIDVALIDITY and missing messages', async () => {
    const imap = fixtureTransport();
    const { provider } = makeProvider({ imap });
    const messageId = encodeMessageRef('imap1', 'INBOX', '777', 12);
    imap.setUidValidity('INBOX', '999');

    await expectRejects(provider.getMessage(messageId, { includeHtml: false, maxBodyChars: 100 }), 'MESSAGE_STALE');
    await expectRejects(
      provider.getMessage(encodeMessageRef('imap1', 'INBOX', '999', 404), {
        includeHtml: false,
        maxBodyChars: 100,
      }),
      'MESSAGE_NOT_FOUND',
    );
  });

  it('reconstructs threads from References headers', async () => {
    const { provider } = makeProvider();
    const result = await provider.getThread(encodeMessageRef('imap1', 'INBOX', '777', 11), { limit: 20 });
    expect(result.method).toBe('references');
    expect(result.complete).toBe(false);
    expect(result.warnings).toContain('thread_is_best_effort');
    expect(result.messages.map((message) => message.uid)).toEqual([11, 12]);
  });

  it('reports folder errors from the transport', async () => {
    const { provider } = makeProvider();
    await expectRejects(provider.listMessages({ folder: 'Missing', limit: 10 }), 'FOLDER_NOT_FOUND');
  });

  it('sends through SMTP only when configured and enabled', async () => {
    const smtp = new FakeSmtpTransport({
      messageId: '<sent@example.com>',
      accepted: ['alex@example.com'],
      rejected: [],
      response: '250 OK',
    });
    const { provider } = makeProvider({ smtp });
    const receipt = await provider.send({
      to: [{ address: 'alex@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Hello',
      text: 'Body',
      html: null,
      inReplyTo: null,
      references: [],
    });
    expect(receipt.accepted).toEqual(['alex@example.com']);
    expect(smtp.envelopes).toHaveLength(1);
    expect(provider.capabilities().send).toBe(true);

    const withoutSmtp = makeProvider({ smtp: null }).provider;
    await expectRejects(
      withoutSmtp.send({
        to: [{ address: 'alex@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        text: 'Body',
        html: null,
        inReplyTo: null,
        references: [],
      }),
      'CAPABILITY_UNSUPPORTED',
    );
  });

  it('does not send when the IMAP account itself has sending disabled', async () => {
    const smtp = new FakeSmtpTransport({
      messageId: '<sent@example.com>',
      accepted: ['alex@example.com'],
      rejected: [],
      response: '250 OK',
    });
    const { provider } = makeProvider({ smtp, config: { sendEnabled: false } });
    await expectRejects(
      provider.send({
        to: [{ address: 'alex@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        text: 'Body',
        html: null,
        inReplyTo: null,
        references: [],
      }),
      'SEND_DISABLED',
    );
    expect(smtp.envelopes).toHaveLength(0);
  });
});
