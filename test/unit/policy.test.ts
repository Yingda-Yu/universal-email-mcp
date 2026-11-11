import { describe, expect, it } from 'vitest';
import { EmailMcpError } from '../../src/core/errors.js';
import { SendPolicy } from '../../src/core/policy.js';
import type { ResolvedAccountConfig } from '../../src/core/types.js';

function account(overrides: Partial<ResolvedAccountConfig> = {}): ResolvedAccountConfig {
  return {
    id: 'demo-a',
    label: 'Demo A',
    email: 'alex@example.com',
    provider: 'mock',
    preset: null,
    username: 'alex@example.com',
    password: null,
    imap: null,
    smtp: null,
    enabled: true,
    sendEnabled: true,
    mockFixture: 'demo-a',
    verificationStatus: 'not-applicable',
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMcpError);
    expect((error as EmailMcpError).code).toBe(code);
    return;
  }
  throw new Error(`Expected EmailMcpError with code ${code}`);
}

describe('SendPolicy', () => {
  it('is disabled by default and reports required approval', () => {
    const policy = SendPolicy.fromEnv({});
    expect(policy.status()).toEqual({
      global_send_enabled: false,
      approval_required: true,
      recipient_allowlist_configured: false,
      rate_limit_per_minute: 10,
    });
    expectCode(() => policy.assertSendEnabled(account()), 'SEND_DISABLED');
  });

  it('requires both the global switch and per-account enablement', () => {
    const policy = new SendPolicy({ globalSendEnabled: true });
    expectCode(() => policy.assertSendEnabled(account({ sendEnabled: false })), 'SEND_DISABLED');
    expect(() => policy.assertSendEnabled(account())).not.toThrow();
  });

  it('enforces exact-address and domain recipient allowlists', () => {
    const policy = new SendPolicy({
      globalSendEnabled: true,
      recipientAllowlist: ['alex@example.com', '@partner.example'],
    });
    expect(() => policy.assertRecipients(['alex@example.com', 'ops@partner.example'])).not.toThrow();
    expectCode(() => policy.assertRecipients(['alex@example.com', 'eve@evil.example']), 'RECIPIENT_NOT_ALLOWED');
    expectCode(() => policy.assertRecipients(['not-a-domain@sub.partner.example']), 'RECIPIENT_NOT_ALLOWED');
  });

  it('rejects invalid allowlist entries at startup', () => {
    expectCode(() => new SendPolicy({ globalSendEnabled: true, recipientAllowlist: ['invalid'] }), 'CONFIG_INVALID');
    expectCode(() => new SendPolicy({ globalSendEnabled: true, recipientAllowlist: ['@bad domain'] }), 'CONFIG_INVALID');
  });

  it('enforces the per-account send rate limit', () => {
    let now = 1_000_000;
    const policy = new SendPolicy({
      globalSendEnabled: true,
      rateLimitPerMinute: 2,
      now: () => now,
    });
    policy.consumeRateLimit('demo-a');
    now += 1_000;
    policy.consumeRateLimit('demo-a');
    now += 1_000;
    expectCode(() => policy.consumeRateLimit('demo-a'), 'RATE_LIMITED');
    // A different account has an independent bucket.
    expect(() => policy.consumeRateLimit('demo-b')).not.toThrow();
    now += 60_000;
    expect(() => policy.consumeRateLimit('demo-a')).not.toThrow();
  });

  it('parses boolean and numeric environment settings strictly', () => {
    const enabled = SendPolicy.fromEnv({
      EMAIL_ENABLE_SEND: 'true',
      EMAIL_RECIPIENT_ALLOWLIST: 'alex@example.com, @partner.example',
      EMAIL_SEND_RATE_LIMIT_PER_MINUTE: '3',
    });
    expect(enabled.status().global_send_enabled).toBe(true);
    expect(enabled.status().rate_limit_per_minute).toBe(3);
    expect(enabled.status().recipient_allowlist_configured).toBe(true);

    expectCode(() => SendPolicy.fromEnv({ EMAIL_SEND_RATE_LIMIT_PER_MINUTE: '0' }), 'CONFIG_INVALID');
    expectCode(() => SendPolicy.fromEnv({ EMAIL_ENABLE_SEND: 'yes' }), 'CONFIG_INVALID');
  });

  it('enforces the recipient count limit', () => {
    const policy = new SendPolicy({ globalSendEnabled: true });
    const recipients = Array.from({ length: 21 }, (_, index) => `user${index}@example.com`);
    expectCode(() => policy.assertRecipients(recipients), 'INVALID_ARGUMENT');
  });
});
