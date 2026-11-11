#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/loader.js';
import { EmailMcpError } from '../core/errors.js';
import { ApprovalService } from '../core/approval.js';
import { DraftStore } from '../core/draft-store.js';

const HELP = `Usage: universal-email-mcp-approve --account <id> --draft <draft_id> --approved-by <name> [options]

Mint a single-use approval token for a locally stored draft. Run this yourself,
out-of-band from the AI agent. The token is bound to the exact draft content and
expires after 15 minutes by default.

Options:
  --account <id>        Account that owns the draft (required)
  --draft <id>          Draft identifier returned by email_create_draft/email_reply (required)
  --approved-by <name>  Human approver identifier recorded in the ledger (required)
  --ttl <seconds>       Token lifetime, 1-3600 seconds (default 900)
  --config <path>       Account configuration file (default: EMAIL_MCP_CONFIG)
  --help                Show this help

The token is printed to stdout exactly once. It cannot be reused.`;

interface CliValues {
  account?: string;
  draft?: string;
  'approved-by'?: string;
  ttl?: string;
  config?: string;
  help?: boolean;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let values: CliValues;
  try {
    const parsed = parseArgs({
      options: {
        account: { type: 'string' },
        draft: { type: 'string' },
        'approved-by': { type: 'string' },
        ttl: { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values as CliValues;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid arguments', 2);
  }

  if (values.help === true) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (values.account === undefined || values.draft === undefined || values['approved-by'] === undefined) {
    process.stdout.write(`${HELP}\n`);
    fail('--account, --draft, and --approved-by are required', 2);
  }

  let ttlSeconds: number | undefined;
  if (values.ttl !== undefined) {
    if (!/^\d+$/.test(values.ttl)) {
      fail('--ttl must be an integer between 1 and 3600', 2);
    }
    ttlSeconds = Number.parseInt(values.ttl, 10);
    if (ttlSeconds < 1 || ttlSeconds > 3600) {
      fail('--ttl must be between 1 and 3600 seconds', 2);
    }
  }

  try {
    const config = await loadConfig({
      ...(values.config === undefined ? {} : { configPath: values.config }),
      env: process.env,
    });
    const account = config.accounts.find((entry) => entry.id === values.account);
    if (account === undefined) {
      fail(`Unknown account: ${values.account}`, 1);
    }
    if (!account.enabled) {
      fail(`Account "${account.id}" is disabled`, 1);
    }
    const drafts = new DraftStore({ dataDir: config.dataDir });
    const draft = await drafts.get(account.id, values.draft as string);
    if (draft.status === 'sent') {
      fail('Draft has already been sent', 1);
    }
    const approvals = new ApprovalService({ dataDir: config.dataDir });
    const minted = await approvals.mint({
      accountId: account.id,
      draftId: draft.id,
      contentHash: draft.contentHash,
      approvedBy: values['approved-by'],
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    });

    if (!account.sendEnabled || process.env.EMAIL_ENABLE_SEND !== 'true') {
      process.stderr.write(
        'warning: sending is currently disabled by EMAIL_ENABLE_SEND and/or the account send.enabled flag. The token will not be usable until both are enabled.\n',
      );
    }

    process.stdout.write(
      [
        'Approval granted (single use)',
        `Account: ${account.id}`,
        `Draft: ${draft.id}`,
        `Expires: ${minted.expiresAt}`,
        '',
        'Token:',
        minted.token,
        '',
        'Give this token to email_send_draft. It is bound to this exact draft content and cannot be reused.',
        '',
      ].join('\n'),
    );
  } catch (error) {
    if (error instanceof EmailMcpError) {
      fail(`${error.code}: ${error.message}`);
    }
    fail(error instanceof Error ? error.message : 'Approval failed');
  }
}

void main();
