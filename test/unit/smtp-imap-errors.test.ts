import { describe, expect, it } from 'vitest';
import { EmailMcpError } from '../../src/core/errors.js';
import type { ResolvedAccountConfig } from '../../src/core/types.js';
import { mapImapError } from '../../src/providers/imap-smtp/imap-transport.js';
import { SmtpSender } from '../../src/providers/imap-smtp/smtp-sender.js';
import {
  mapSmtpError,
  type SmtpEnvelope,
  type SmtpResult,
  type SmtpTransport,
} from '../../src/providers/imap-smtp/smtp-transport.js';

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

class FakeSmtpTransport implements SmtpTransport {
  readonly envelopes: SmtpEnvelope[] = [];
  closeCalls = 0;
  constructor(private readonly result: SmtpResult | Error) {}
  async send(envelope: SmtpEnvelope): Promise<SmtpResult> {
    this.envelopes.push(envelope);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
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

const outgoing = {
  to: [{ address: 'alex@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Hello',
  text: 'Body',
  html: null,
  inReplyTo: '<original@example.com>',
  references: ['<original@example.com>'],
};

describe('mapSmtpError', () => {
  it('maps authentication, timeout, connection, and envelope errors', () => {
    expect(mapSmtpError({ code: 'EAUTH', message: 'Invalid login' }).code).toBe('AUTHENTICATION_FAILED');
    expect(mapSmtpError({ code: 'ETIMEDOUT', message: 'Timed out' }).code).toBe('TIMEOUT');
    expect(mapSmtpError({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' }).code).toBe('CONNECTION_FAILED');
    expect(mapSmtpError({ code: 'EENVELOPE', message: 'Bad recipient' }).code).toBe('SMTP_SEND_FAILED');
  });

  it('keeps SMTP response codes in details and redacts secrets', () => {
    const error = mapSmtpError({
      code: 'EMESSAGE',
      message: 'auth failed password=hunter2',
      responseCode: 550,
    });
    expect(error.code).toBe('SMTP_SEND_FAILED');
    expect(error.message).not.toContain('hunter2');
    expect(error.details).toEqual({ smtp_response_code: 550 });
  });

  it('passes through EmailMcpError instances unchanged', () => {
    const original = new EmailMcpError('SMTP_SEND_FAILED', 'already mapped');
    expect(mapSmtpError(original)).toBe(original);
  });
});

describe('mapImapError', () => {
  it('maps authentication, timeout, TLS, folder, and connection failures', () => {
    expect(mapImapError({ authenticationFailed: true, message: 'auth' }).code).toBe('AUTHENTICATION_FAILED');
    expect(mapImapError({ code: 'ETIMEDOUT', message: 'timeout' }).code).toBe('TIMEOUT');
    expect(mapImapError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'certificate' }).code).toBe('CONNECTION_FAILED');
    expect(mapImapError({ code: 'MailboxDoesNotExist', message: 'not found' }).code).toBe('FOLDER_NOT_FOUND');
    expect(mapImapError({ code: 'ECONNREFUSED', message: 'refused' }).code).toBe('CONNECTION_FAILED');
  });

  it('redacts secrets and falls back to PROVIDER_ERROR', () => {
    const error = mapImapError({ message: 'unexpected token=abc123' });
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.message).not.toContain('abc123');
  });
});

describe('SmtpSender', () => {
  it('refuses to send when the account is disabled for sending', async () => {
    const transport = new FakeSmtpTransport({
      messageId: '<x@example.com>',
      accepted: ['alex@example.com'],
      rejected: [],
      response: '250 OK',
    });
    const sender = new SmtpSender(account({ sendEnabled: false }), transport);
    await expectRejects(sender.send(outgoing), 'SEND_DISABLED');
    expect(transport.envelopes).toHaveLength(0);
  });

  it('refuses to send when SMTP is not configured', async () => {
    const transport = new FakeSmtpTransport({
      messageId: '<x@example.com>',
      accepted: ['alex@example.com'],
      rejected: [],
      response: '250 OK',
    });
    const sender = new SmtpSender(account({ smtp: null }), transport);
    await expectRejects(sender.send(outgoing), 'CAPABILITY_UNSUPPORTED');
  });

  it('reports partial delivery and success receipts', async () => {
    const transport = new FakeSmtpTransport({
      messageId: '<sent@example.com>',
      accepted: ['alex@example.com'],
      rejected: ['blair@example.org'],
      response: '250 2.0.0 Queued',
    });
    const sender = new SmtpSender(account(), transport);
    const receipt = await sender.send({
      ...outgoing,
      cc: [{ address: 'blair@example.org' }],
    });
    expect(receipt.providerMessageId).toBe('<sent@example.com>');
    expect(receipt.accepted).toEqual(['alex@example.com']);
    expect(receipt.rejected).toEqual(['blair@example.org']);
    expect(receipt.partial).toBe(true);
    expect(transport.envelopes).toHaveLength(1);
    expect(transport.envelopes[0]?.from).toEqual({ name: 'Corporate A', address: 'alice@corp.example' });
    expect(transport.envelopes[0]?.inReplyTo).toBe('<original@example.com>');
  });

  it('fails when every recipient is rejected', async () => {
    const transport = new FakeSmtpTransport({
      messageId: null,
      accepted: [],
      rejected: ['alex@example.com'],
      response: '550 rejected',
    });
    const sender = new SmtpSender(account(), transport);
    await expectRejects(sender.send(outgoing), 'SMTP_SEND_FAILED');
  });

  it('propagates mapped transport failures', async () => {
    const transport = new FakeSmtpTransport(
      new EmailMcpError('AUTHENTICATION_FAILED', 'SMTP authentication failed'),
    );
    const sender = new SmtpSender(account(), transport);
    await expectRejects(sender.send(outgoing), 'AUTHENTICATION_FAILED');
  });
});
