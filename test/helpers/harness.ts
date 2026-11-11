import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../../src/core/account-manager.js';
import { ApprovalService } from '../../src/core/approval.js';
import { DraftStore } from '../../src/core/draft-store.js';
import { createLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/logger.js';
import { SendPolicy } from '../../src/core/policy.js';
import type { ResolvedAccountConfig } from '../../src/core/types.js';
import { createProvider } from '../../src/providers/index.js';
import { MockEmailProvider } from '../../src/providers/mock/mock-provider.js';
import { EmailTools } from '../../src/tools/handlers.js';

export interface MockHarnessOptions {
  globalSendEnabled?: boolean;
  accountSendEnabled?: boolean;
  allowlist?: string[];
  rateLimitPerMinute?: number;
  sendFailures?: Record<string, 'authentication' | 'connection' | 'rejected'>;
  now?: () => Date;
}

export interface MockHarness {
  dataDir: string;
  accounts: AccountManager;
  drafts: DraftStore;
  approvals: ApprovalService;
  policy: SendPolicy;
  tools: EmailTools;
  logger: Logger;
  mockProvider(accountId: string): MockEmailProvider;
  cleanup(): Promise<void>;
}

export function mockAccount(
  id: string,
  email: string,
  fixture: string,
  sendEnabled = false,
): ResolvedAccountConfig {
  return {
    id,
    label: id,
    email,
    provider: 'mock',
    preset: null,
    username: email,
    password: null,
    imap: null,
    smtp: null,
    enabled: true,
    sendEnabled,
    mockFixture: fixture,
    verificationStatus: 'not-applicable',
  };
}

export async function createMockHarness(options: MockHarnessOptions = {}): Promise<MockHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'email-mcp-test-'));
  const accounts = new AccountManager(
    [
      mockAccount('demo-a', 'alex@example.com', 'demo-a', options.accountSendEnabled ?? true),
      mockAccount('demo-b', 'blair@example.org', 'demo-b', options.accountSendEnabled ?? true),
    ],
    (config) =>
      createProvider(config, {
        env: {},
        ...(options.sendFailures === undefined ? {} : { mockSendFailures: options.sendFailures }),
      }),
  );
  const logger = createLogger({ level: 'silent' });
  const drafts = new DraftStore({ dataDir, ...(options.now === undefined ? {} : { now: options.now }) });
  const approvals = new ApprovalService({
    dataDir,
    ...(options.now === undefined ? {} : { now: options.now }),
    logger,
  });
  const policy = new SendPolicy({
    globalSendEnabled: options.globalSendEnabled ?? false,
    recipientAllowlist: options.allowlist ?? [],
    rateLimitPerMinute: options.rateLimitPerMinute ?? 10,
  });
  const tools = new EmailTools({ accounts, drafts, approvals, policy, logger });

  return {
    dataDir,
    accounts,
    drafts,
    approvals,
    policy,
    tools,
    logger,
    mockProvider(accountId: string): MockEmailProvider {
      const provider = accounts.get(accountId).provider;
      if (!(provider instanceof MockEmailProvider)) {
        throw new Error('Provider is not a MockEmailProvider');
      }
      return provider;
    },
    async cleanup(): Promise<void> {
      await accounts.closeAll();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function writeAccountsConfig(
  directory: string,
  accounts: unknown[],
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'accounts.json');
  await writeFile(path, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function mockAccountsConfig(): unknown[] {
  return [
    {
      id: 'demo-a',
      label: 'Demo A',
      email: 'alex@example.com',
      provider: 'mock',
      mock: { fixture: 'demo-a' },
      send: { enabled: true },
    },
    {
      id: 'demo-b',
      label: 'Demo B',
      email: 'blair@example.org',
      provider: 'mock',
      mock: { fixture: 'demo-b' },
      send: { enabled: true },
    },
  ];
}
