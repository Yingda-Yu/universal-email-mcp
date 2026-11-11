import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { EmailMcpError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import type { EndpointConfig, ResolvedAccountConfig } from '../core/types.js';
import {
  assertSafeRemoteHost,
  isLoopbackHost,
  parseBooleanEnv,
} from '../core/validate.js';
import { getPreset } from './presets.js';
import { configFileSchema, formatZodIssues, type RawAccountConfig } from './schema.js';

export interface LoadedConfig {
  configPath: string;
  dataDir: string;
  accounts: ResolvedAccountConfig[];
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EMAIL_MCP_CONFIG;
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(configured);
  }
  return join(homedir(), '.config', 'universal-email-mcp', 'accounts.json');
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EMAIL_MCP_DATA_DIR;
  return resolve(configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), '.universal-email-mcp'));
}

function validateEndpoint(
  endpoint: EndpointConfig,
  kind: 'IMAP' | 'SMTP',
  accountId: string,
  env: NodeJS.ProcessEnv,
): EndpointConfig {
  const allowPrivateHosts = parseBooleanEnv(env.EMAIL_ALLOW_PRIVATE_HOSTS, false);
  const host = assertSafeRemoteHost(endpoint.host, allowPrivateHosts);
  if (!endpoint.secure) {
    if ((endpoint.port === 993 && kind === 'IMAP') || (endpoint.port === 465 && kind === 'SMTP')) {
      throw new EmailMcpError(
        'CONFIG_INVALID',
        `${kind} port ${endpoint.port} requires secure=true for account "${accountId}"`,
      );
    }
    if (!endpoint.requireTls) {
      const insecureAllowed = parseBooleanEnv(env.EMAIL_ALLOW_INSECURE_TRANSPORT, false);
      if (!insecureAllowed || !isLoopbackHost(host)) {
        throw new EmailMcpError(
          'CONFIG_INVALID',
          `${kind} cleartext transport is only allowed for loopback hosts with EMAIL_ALLOW_INSECURE_TRANSPORT=true (account "${accountId}")`,
        );
      }
    }
  }
  return { ...endpoint, host };
}

function resolveEndpoint(
  fromConfig: EndpointConfig | undefined,
  fromPreset: EndpointConfig | undefined,
  kind: 'IMAP' | 'SMTP',
  required: boolean,
  accountId: string,
  env: NodeJS.ProcessEnv,
): EndpointConfig | null {
  const endpoint = fromConfig ?? fromPreset;
  if (endpoint === undefined) {
    if (required) {
      throw new EmailMcpError('CONFIG_INVALID', `${kind} endpoint is required for account "${accountId}"`);
    }
    return null;
  }
  return validateEndpoint(endpoint, kind, accountId, env);
}

function resolvePassword(
  account: RawAccountConfig,
  env: NodeJS.ProcessEnv,
): string | null {
  if (account.password !== undefined) {
    return account.password;
  }
  if (account.passwordEnv !== undefined) {
    const value = env[account.passwordEnv];
    if (value === undefined || value.length === 0) {
      throw new EmailMcpError(
        'CONFIG_INVALID',
        `Environment variable ${account.passwordEnv} is not set for account "${account.id}"`,
      );
    }
    return value;
  }
  return null;
}

function resolveAccount(account: RawAccountConfig, env: NodeJS.ProcessEnv): ResolvedAccountConfig {
  const preset = account.preset === undefined ? undefined : getPreset(account.preset);
  if (account.preset !== undefined && preset === undefined) {
    throw new EmailMcpError('CONFIG_INVALID', `Unknown provider preset "${account.preset}" for account "${account.id}"`);
  }
  if (preset !== undefined && preset.id === 'custom') {
    if (account.imap === undefined || account.smtp === undefined) {
      throw new EmailMcpError(
        'CONFIG_INVALID',
        `The "custom" preset requires explicit imap and smtp endpoints for account "${account.id}"`,
      );
    }
  }

  let imap: EndpointConfig | null = null;
  let smtp: EndpointConfig | null = null;
  if (account.provider === 'imap-smtp') {
    imap = resolveEndpoint(account.imap, preset?.imap, 'IMAP', true, account.id, env);
    smtp = resolveEndpoint(account.smtp, preset?.smtp, 'SMTP', false, account.id, env);
    if (imap === null) {
      throw new EmailMcpError('CONFIG_INVALID', `IMAP endpoint is required for account "${account.id}"`);
    }
  }

  const password = account.provider === 'imap-smtp' ? resolvePassword(account, env) : null;
  if (account.provider === 'imap-smtp' && password === null) {
    throw new EmailMcpError(
      'CONFIG_INVALID',
      `Account "${account.id}" requires password or passwordEnv for IMAP/SMTP authentication`,
    );
  }

  const verificationStatus =
    account.provider === 'mock'
      ? 'not-applicable'
      : preset !== undefined
        ? preset.status
        : 'configured';

  return {
    id: account.id,
    label: account.label,
    email: account.email,
    provider: account.provider,
    preset: account.preset ?? null,
    username: account.username ?? account.email,
    password,
    imap,
    smtp,
    enabled: account.enabled,
    sendEnabled: account.send.enabled,
    mockFixture: account.mock?.fixture ?? null,
    verificationStatus,
  };
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath === undefined ? defaultConfigPath(env) : resolve(options.configPath);
  const dataDir = resolveDataDir(env);

  let fileStat;
  try {
    fileStat = await stat(configPath);
  } catch {
    throw new EmailMcpError(
      'CONFIG_INVALID',
      `Configuration file not found at ${configPath}. Set EMAIL_MCP_CONFIG or copy examples/accounts.example.json.`,
    );
  }
  if (!fileStat.isFile()) {
    throw new EmailMcpError('CONFIG_INVALID', 'EMAIL_MCP_CONFIG must point to a regular file');
  }
  if (fileStat.size > LIMITS.maxConfigFileBytes) {
    throw new EmailMcpError('CONFIG_INVALID', 'Configuration file is too large');
  }

  const rawText = await readFile(configPath, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new EmailMcpError('CONFIG_INVALID', 'Configuration file is not valid JSON');
  }

  const parsed = configFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new EmailMcpError('CONFIG_INVALID', 'Configuration file failed validation', {
      details: { issues: formatZodIssues(parsed.error) },
    });
  }

  const accounts = parsed.data.accounts.map((account) => resolveAccount(account, env));
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new EmailMcpError('CONFIG_INVALID', `Duplicate account id "${account.id}"`);
    }
    seen.add(account.id);
  }

  return { configPath, dataDir, accounts };
}

export function describeConfigError(error: unknown): string {
  if (error instanceof EmailMcpError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'Configuration validation failed';
  }
  return 'Configuration could not be loaded';
}
