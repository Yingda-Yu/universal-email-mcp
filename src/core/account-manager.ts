import { EmailMcpError } from './errors.js';
import type { EmailProvider, PublicAccount, ResolvedAccountConfig } from './types.js';
import { ACCOUNT_ID_PATTERN } from '../config/schema.js';

export interface AccountEntry {
  config: ResolvedAccountConfig;
  provider: EmailProvider;
}

/**
 * Owns account lookup and provider instances. Each account gets a dedicated
 * provider so credentials and transport state can never bleed across accounts.
 */
export class AccountManager {
  private readonly entries = new Map<string, AccountEntry>();

  constructor(accounts: readonly ResolvedAccountConfig[], factory: (config: ResolvedAccountConfig) => EmailProvider) {
    for (const config of accounts) {
      if (this.entries.has(config.id)) {
        throw new EmailMcpError('CONFIG_INVALID', `Duplicate account id "${config.id}"`);
      }
      this.entries.set(config.id, { config, provider: factory(config) });
    }
    if (this.entries.size === 0) {
      throw new EmailMcpError('CONFIG_INVALID', 'At least one email account must be configured');
    }
  }

  list(): PublicAccount[] {
    return [...this.entries.values()].map((entry) => {
      let capabilities;
      try {
        capabilities = entry.provider.capabilities();
      } catch {
        capabilities = {
          implemented: false,
          read: false,
          search: 'none' as const,
          thread: 'none' as const,
          send: false,
          remoteDrafts: false as const,
          attachments: false as const,
          flags: false as const,
        };
      }
      return {
        account_id: entry.config.id,
        label: entry.config.label,
        email: entry.config.email,
        provider: entry.config.provider,
        preset: entry.config.preset,
        enabled: entry.config.enabled,
        send_enabled: entry.config.sendEnabled,
        verification_status: entry.config.verificationStatus,
        capabilities,
      };
    });
  }

  get(accountId: string): AccountEntry {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new EmailMcpError('INVALID_ARGUMENT', 'account_id has an invalid format');
    }
    const entry = this.entries.get(accountId);
    if (entry === undefined) {
      throw new EmailMcpError('UNKNOWN_ACCOUNT', `Unknown account: ${accountId}`);
    }
    if (!entry.config.enabled) {
      throw new EmailMcpError('ACCOUNT_DISABLED', `Account "${accountId}" is disabled`);
    }
    return entry;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.provider.close()));
  }
}
