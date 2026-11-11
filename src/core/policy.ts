import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';
import type { ResolvedAccountConfig } from './types.js';
import { isValidEmailAddress, parseBooleanEnv } from './validate.js';

export interface SendPolicyOptions {
  globalSendEnabled: boolean;
  recipientAllowlist?: readonly string[];
  rateLimitPerMinute?: number;
  maxRecipients?: number;
  now?: () => number;
}

export interface SendPolicyStatus {
  global_send_enabled: boolean;
  approval_required: true;
  recipient_allowlist_configured: boolean;
  rate_limit_per_minute: number;
}

function parsePositiveInt(value: string | undefined, defaultValue: number, field: string): number {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new EmailMcpError('CONFIG_INVALID', `${field} must be a non-negative integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new EmailMcpError('CONFIG_INVALID', `${field} must be greater than zero`);
  }
  return parsed;
}

function normalizeAllowlistEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.startsWith('@')) {
    if (!isValidEmailAddress(`allowlist${trimmed}`)) {
      throw new EmailMcpError('CONFIG_INVALID', 'EMAIL_RECIPIENT_ALLOWLIST contains an invalid domain entry');
    }
    return trimmed;
  }
  if (!isValidEmailAddress(trimmed)) {
    throw new EmailMcpError(
      'CONFIG_INVALID',
      'EMAIL_RECIPIENT_ALLOWLIST entries must be full addresses or @domain values',
    );
  }
  return trimmed;
}

/**
 * Server-side send policy. Sending requires all of:
 *   1. EMAIL_ENABLE_SEND=true (global human-controlled switch),
 *   2. send.enabled=true for the account,
 *   3. a valid single-use approval token minted out-of-band,
 *   4. recipient allowlist match when configured,
 *   5. rate limit and recipient count limits.
 */
export class SendPolicy {
  private readonly globalSendEnabled: boolean;
  private readonly allowlist: string[];
  private readonly rateLimitPerMinute: number;
  private readonly maxRecipients: number;
  private readonly now: () => number;
  private readonly attempts = new Map<string, number[]>();

  constructor(options: SendPolicyOptions) {
    this.globalSendEnabled = options.globalSendEnabled;
    this.allowlist = (options.recipientAllowlist ?? []).map(normalizeAllowlistEntry);
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? 10;
    this.maxRecipients = Math.min(options.maxRecipients ?? LIMITS.maxRecipients, LIMITS.maxRecipients);
    this.now = options.now ?? (() => Date.now());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SendPolicy {
    const allowlistRaw = env.EMAIL_RECIPIENT_ALLOWLIST;
    return new SendPolicy({
      globalSendEnabled: parseBooleanEnv(env.EMAIL_ENABLE_SEND, false),
      recipientAllowlist:
        allowlistRaw === undefined || allowlistRaw.trim().length === 0
          ? []
          : allowlistRaw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      rateLimitPerMinute: parsePositiveInt(env.EMAIL_SEND_RATE_LIMIT_PER_MINUTE, 10, 'EMAIL_SEND_RATE_LIMIT_PER_MINUTE'),
      maxRecipients: parsePositiveInt(env.EMAIL_SEND_MAX_RECIPIENTS, LIMITS.maxRecipients, 'EMAIL_SEND_MAX_RECIPIENTS'),
    });
  }

  status(): SendPolicyStatus {
    return {
      global_send_enabled: this.globalSendEnabled,
      approval_required: true,
      recipient_allowlist_configured: this.allowlist.length > 0,
      rate_limit_per_minute: this.rateLimitPerMinute,
    };
  }

  assertSendEnabled(account: ResolvedAccountConfig): void {
    if (!this.globalSendEnabled) {
      throw new EmailMcpError(
        'SEND_DISABLED',
        'Sending is globally disabled. Set EMAIL_ENABLE_SEND=true and restart the server after reviewing SECURITY.md',
      );
    }
    if (!account.sendEnabled) {
      throw new EmailMcpError('SEND_DISABLED', `Sending is disabled for account "${account.id}" in the account configuration`);
    }
  }

  assertRecipients(recipients: readonly string[]): void {
    const unique = [...new Set(recipients.map((address) => address.toLowerCase()))];
    if (unique.length > this.maxRecipients) {
      throw new EmailMcpError('INVALID_ARGUMENT', `Recipient count exceeds the limit of ${this.maxRecipients}`);
    }
    if (this.allowlist.length === 0) {
      return;
    }
    for (const address of unique) {
      const allowed = this.allowlist.some((entry) =>
        entry.startsWith('@') ? address.endsWith(entry) : address === entry,
      );
      if (!allowed) {
        throw new EmailMcpError('RECIPIENT_NOT_ALLOWED', 'A recipient is not permitted by EMAIL_RECIPIENT_ALLOWLIST', {
          details: { recipient: address },
        });
      }
    }
  }

  consumeRateLimit(accountId: string): void {
    const now = this.now();
    const windowStart = now - 60_000;
    const history = (this.attempts.get(accountId) ?? []).filter((timestamp) => timestamp > windowStart);
    if (history.length >= this.rateLimitPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((history[0]! + 60_000 - now) / 1000));
      throw new EmailMcpError('RATE_LIMITED', 'Send rate limit exceeded for this account', {
        retryable: true,
        details: { retry_after_seconds: retryAfterSeconds },
      });
    }
    history.push(now);
    this.attempts.set(accountId, history);
  }
}
