import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { getPreset, listPublicPresets } from '../../src/config/presets.js';
import { EmailMcpError } from '../../src/core/errors.js';

async function expectRejects(promise: Promise<unknown>, code: string): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMcpError);
    expect((error as EmailMcpError).code).toBe(code);
    return error as Error;
  }
  throw new Error(`Expected EmailMcpError with code ${code}`);
}

function imapAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'corp-a',
    label: 'Corporate A',
    email: 'alice@corp.example',
    provider: 'imap-smtp',
    preset: 'netease-enterprise',
    username: 'alice@corp.example',
    passwordEnv: 'CORP_MAIL_PASSWORD',
    send: { enabled: false },
    ...overrides,
  };
}

describe('provider presets', () => {
  it('exposes documented endpoints without marking them verified', () => {
    const preset = getPreset('netease-enterprise');
    expect(preset?.imap).toEqual({ host: 'imap.qiye.163.com', port: 993, secure: true, requireTls: true });
    expect(preset?.smtp).toEqual({ host: 'smtp.qiye.163.com', port: 465, secure: true, requireTls: true });
    expect(preset?.status).toBe('documented');

    const publicPresets = listPublicPresets();
    expect(publicPresets.length).toBeGreaterThanOrEqual(6);
    expect(publicPresets.map((entry) => entry.preset_id)).toEqual(
      expect.arrayContaining(['netease-enterprise', 'alibaba-enterprise', 'tencent-enterprise', 'qq', 'netease-163', 'netease-126']),
    );
    expect(publicPresets.every((entry) => entry.verification_status !== 'verified-live')).toBe(true);
  });
});

describe('loadConfig', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'email-mcp-config-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeConfig(accounts: unknown[]): Promise<string> {
    const path = join(dataDir, 'accounts.json');
    await writeFile(path, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 });
    return path;
  }

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { EMAIL_MCP_DATA_DIR: dataDir, ...extra };
  }

  it('resolves preset endpoints and credentials from the environment', async () => {
    const configPath = await writeConfig([imapAccount()]);
    const loaded = await loadConfig({
      configPath,
      env: env({ CORP_MAIL_PASSWORD: 'app-password-value' }),
    });
    expect(loaded.configPath).toBe(configPath);
    expect(loaded.dataDir).toBe(dataDir);
    expect(loaded.accounts).toHaveLength(1);
    const account = loaded.accounts[0]!;
    expect(account.imap).toEqual({
      host: 'imap.qiye.163.com',
      port: 993,
      secure: true,
      requireTls: true,
    });
    expect(account.smtp).toEqual({
      host: 'smtp.qiye.163.com',
      port: 465,
      secure: true,
      requireTls: true,
    });
    expect(account.password).toBe('app-password-value');
    expect(account.verificationStatus).toBe('documented');
    expect(account.sendEnabled).toBe(false);
  });

  it('supports standard IMAP/SMTP providers', async () => {
    for (const [preset, host] of [
      ['alibaba-enterprise', 'imap.qiye.aliyun.com'],
      ['tencent-enterprise', 'imap.exmail.qq.com'],
      ['qq', 'imap.qq.com'],
      ['netease-163', 'imap.163.com'],
      ['netease-126', 'imap.126.com'],
    ] as const) {
      const configPath = await writeConfig([
        imapAccount({ id: `acct-${preset}`, preset }),
      ]);
      const loaded = await loadConfig({
        configPath,
        env: env({ CORP_MAIL_PASSWORD: 'secret' }),
      });
      expect(loaded.accounts[0]?.imap?.host).toBe(host);
    }
  });

  it('supports explicit custom endpoints', async () => {
    const configPath = await writeConfig([
      imapAccount({
        id: 'custom-a',
        preset: 'custom',
        imap: { host: 'mail.internal.example', port: 993, secure: true, requireTls: true },
        smtp: { host: 'mail.internal.example', port: 465, secure: true, requireTls: true },
      }),
    ]);
    const loaded = await loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) });
    expect(loaded.accounts[0]?.imap?.host).toBe('mail.internal.example');
    expect(loaded.accounts[0]?.verificationStatus).toBe('configured');
  });

  it('fills a custom account without a preset but requires explicit endpoints', async () => {
    const configPath = await writeConfig([imapAccount({ id: 'custom-b', preset: undefined })]);
    const error = await expectRejects(
      loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('IMAP endpoint is required');
  });

  it('rejects the custom preset placeholder endpoints', async () => {
    const configPath = await writeConfig([imapAccount({ id: 'custom-c', preset: 'custom' })]);
    const error = await expectRejects(
      loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('custom');
  });

  it('rejects duplicate account ids', async () => {
    const configPath = await writeConfig([imapAccount(), imapAccount()]);
    const error = await expectRejects(
      loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('Duplicate account id');
  });

  it('rejects missing password environment variables without leaking values', async () => {
    const configPath = await writeConfig([imapAccount()]);
    const error = await expectRejects(loadConfig({ configPath, env: env() }), 'CONFIG_INVALID');
    expect(error.message).toContain('CORP_MAIL_PASSWORD');
    expect(JSON.stringify(error)).not.toContain('app-password-value');
  });

  it('accepts inline passwords while keeping them out of public fields', async () => {
    const configPath = await writeConfig([
      imapAccount({ passwordEnv: undefined, password: 'inline-secret' }),
    ]);
    const loaded = await loadConfig({ configPath, env: env() });
    expect(loaded.accounts[0]?.password).toBe('inline-secret');
    expect(loaded.accounts[0]?.label).toBe('Corporate A');
  });

  it('rejects cleartext transport on implicit TLS ports', async () => {
    const configPath = await writeConfig([
      imapAccount({
        imap: { host: 'imap.corp.example', port: 993, secure: false, requireTls: true },
      }),
    ]);
    const error = await expectRejects(
      loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'CONFIG_INVALID',
    );
    expect(error.message).toContain('secure=true');
  });

  it('blocks private hosts and cloud metadata endpoints', async () => {
    const configPath = await writeConfig([
      imapAccount({
        imap: { host: '10.0.0.5', port: 993, secure: true, requireTls: true },
      }),
    ]);
    await expectRejects(loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }), 'SECURITY_BLOCKED');

    const metadataPath = await writeConfig([
      imapAccount({
        imap: { host: '169.254.169.254', port: 993, secure: true, requireTls: true },
      }),
    ]);
    await expectRejects(
      loadConfig({ configPath: metadataPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'SECURITY_BLOCKED',
    );
  });

  it('rejects unknown presets and invalid configuration without echoing secrets', async () => {
    const configPath = await writeConfig([imapAccount({ preset: 'does-not-exist' })]);
    await expectRejects(
      loadConfig({ configPath, env: env({ CORP_MAIL_PASSWORD: 'secret' }) }),
      'CONFIG_INVALID',
    );

    const invalidPath = await writeConfig([
      imapAccount({ email: 'not-an-email', password: 'super-secret-inline' }),
    ]);
    const error = await expectRejects(loadConfig({ configPath: invalidPath, env: env() }), 'CONFIG_INVALID');
    expect(JSON.stringify(error)).not.toContain('super-secret-inline');
  });

  it('rejects configuration files that do not exist', async () => {
    await expectRejects(
      loadConfig({ configPath: join(dataDir, 'missing.json'), env: env() }),
      'CONFIG_INVALID',
    );
  });

  it('loads mock accounts without credentials', async () => {
    const configPath = await writeConfig([
      {
        id: 'demo-a',
        label: 'Demo A',
        email: 'alex@example.com',
        provider: 'mock',
        mock: { fixture: 'demo-a' },
      },
    ]);
    const loaded = await loadConfig({ configPath, env: env() });
    expect(loaded.accounts[0]).toMatchObject({
      id: 'demo-a',
      provider: 'mock',
      password: null,
      verificationStatus: 'not-applicable',
      mockFixture: 'demo-a',
    });
  });

  it('rejects mock accounts that contain credentials', async () => {
    const configPath = await writeConfig([
      {
        id: 'demo-a',
        label: 'Demo A',
        email: 'alex@example.com',
        provider: 'mock',
        password: 'should-not-be-here',
      },
    ]);
    await expectRejects(loadConfig({ configPath, env: env() }), 'CONFIG_INVALID');
  });
});
