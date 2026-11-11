import { EmailMcpError } from '../core/errors.js';
import type { EmailProvider, ResolvedAccountConfig } from '../core/types.js';
import { parseBooleanEnv } from '../core/validate.js';
import { GmailApiProvider } from './gmail/gmail-provider.js';
import { MicrosoftGraphProvider } from './graph/graph-provider.js';
import { ImapFlowTransport } from './imap-smtp/imap-transport.js';
import { ImapSmtpProvider } from './imap-smtp/provider.js';
import { NodemailerSmtpTransport } from './imap-smtp/smtp-transport.js';
import { SmtpSender } from './imap-smtp/smtp-sender.js';
import { MockEmailProvider, type MockAccountSeed } from './mock/mock-provider.js';
import { getMockFixture } from './mock/fixtures.js';

export interface ProviderFactoryOptions {
  env?: NodeJS.ProcessEnv;
  /** Test/dev injection keyed by mock fixture id. */
  mockSeeds?: Record<string, MockAccountSeed>;
  /** Deterministic send failures for integration tests, keyed by account id. */
  mockSendFailures?: Record<string, 'authentication' | 'connection' | 'rejected'>;
  maxMessageBytes?: number;
}

export function createProvider(config: ResolvedAccountConfig, options: ProviderFactoryOptions = {}): EmailProvider {
  const env = options.env ?? process.env;
  switch (config.provider) {
    case 'mock': {
      let seed: MockAccountSeed = { messages: [] };
      if (config.mockFixture !== null) {
        const injected = options.mockSeeds?.[config.mockFixture];
        const fixture = injected ?? getMockFixture(config.mockFixture);
        if (fixture === undefined) {
          throw new EmailMcpError(
            'CONFIG_INVALID',
            `Unknown mock fixture "${config.mockFixture}" for account "${config.id}"`,
          );
        }
        seed = fixture;
      }
      return new MockEmailProvider({
        config,
        seed,
        sendFailure: options.mockSendFailures?.[config.id] ?? null,
      });
    }
    case 'imap-smtp': {
      if (config.imap === null || config.password === null) {
        throw new EmailMcpError('CONFIG_INVALID', `IMAP account "${config.id}" is missing endpoint or credentials`);
      }
      const allowPrivateHosts = parseBooleanEnv(env.EMAIL_ALLOW_PRIVATE_HOSTS, false);
      const imap = new ImapFlowTransport({
        host: config.imap.host,
        port: config.imap.port,
        secure: config.imap.secure,
        requireTls: config.imap.requireTls,
        username: config.username,
        password: config.password,
        allowPrivateHosts,
      });
      let smtpSender: SmtpSender | null = null;
      if (config.smtp !== null) {
        const transport = new NodemailerSmtpTransport({
          endpoint: config.smtp,
          username: config.username,
          password: config.password,
        });
        smtpSender = new SmtpSender(config, transport);
      }
      return new ImapSmtpProvider({
        config,
        imap,
        smtpSender,
        maxMessageBytes: options.maxMessageBytes,
      });
    }
    case 'gmail':
      return new GmailApiProvider();
    case 'graph':
      return new MicrosoftGraphProvider();
    default: {
      const exhaustive: never = config.provider;
      throw new EmailMcpError('CONFIG_INVALID', `Unsupported provider kind: ${String(exhaustive)}`);
    }
  }
}
