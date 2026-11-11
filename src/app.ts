import { EmailMcpError } from './core/errors.js';
import { loadConfig, type LoadedConfig } from './config/loader.js';
import { AccountManager } from './core/account-manager.js';
import { ApprovalService } from './core/approval.js';
import { DraftStore } from './core/draft-store.js';
import { createLogger, type Logger } from './core/logger.js';
import { SendPolicy } from './core/policy.js';
import type { ToolDependencies } from './tools/handlers.js';
import { createProvider, type ProviderFactoryOptions } from './providers/index.js';

export interface AppServices extends ToolDependencies {
  config: LoadedConfig;
}

export interface BuildServicesOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  providerOptions?: Omit<ProviderFactoryOptions, 'env'>;
}

function parseApprovalTtl(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.EMAIL_APPROVAL_TTL_SECONDS;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new EmailMcpError('CONFIG_INVALID', 'EMAIL_APPROVAL_TTL_SECONDS must be a positive integer');
  }
  return Number.parseInt(raw, 10);
}

export async function buildServices(options: BuildServicesOptions = {}): Promise<AppServices> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ level: 'info' });
  const config = await loadConfig({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    env,
  });
  const accounts = new AccountManager(config.accounts, (account) =>
    createProvider(account, {
      env,
      ...(options.providerOptions ?? {}),
    }),
  );
  const drafts = new DraftStore({ dataDir: config.dataDir });
  const approvalTtl = parseApprovalTtl(env);
  const approvals = new ApprovalService({
    dataDir: config.dataDir,
    logger,
    ...(approvalTtl === undefined ? {} : { defaultTtlSeconds: approvalTtl }),
  });
  const policy = SendPolicy.fromEnv(env);

  return {
    config,
    accounts,
    drafts,
    approvals,
    policy,
    logger,
  };
}

export async function closeServices(services: AppServices): Promise<void> {
  await services.accounts.closeAll();
}
