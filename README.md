# universal-email-mcp

A provider-agnostic, multi-account [Model Context Protocol](https://modelcontextprotocol.io) server for AI agents to read, search, thread, draft, reply to, and send email. The first release uses generic IMAP/SMTP so it can work with consumer and enterprise mailboxes without vendor-specific code paths in the core.

> **Status: v0.1.0.** The mock test suite is complete and passing. No live mailbox provider is marked as verified yet — see [docs/provider-compatibility.md](docs/provider-compatibility.md). Simulated tests do not prove that a provider works in production.

## Features

- 9 MCP tools for listing accounts and folders, listing/searching messages, reading a message, reconstructing a best-effort thread, creating a draft, replying, and sending a draft.
- Multiple isolated accounts in one server process. Every message reference is resolved through the account that produced it.
- Generic IMAP/SMTP adapter with presets for NetEase Enterprise, Alibaba Enterprise, Tencent Exmail, QQ Mail, 163, 126, and custom servers.
- Local draft storage with `0600` files and content-hash tamper detection.
- **Sending is disabled by default.** Enabling it requires both an operator-controlled global switch and a per-account switch, plus a single-use approval token minted by a human outside the MCP session.
- Conservative defenses: TLS by default, no cleartext on 993/465, SSRF/metadata host blocking, CRLF/header-injection rejection, strict input validation, body size limits, secret redaction in logs and errors, and sanitization of untrusted HTML.
- Mock provider with two deterministic mailboxes so the whole tool surface can be exercised without network access or credentials.
- Gmail API and Microsoft Graph adapters are reserved as separate provider interfaces and currently return `PROVIDER_NOT_IMPLEMENTED`.

## Requirements

- Node.js >= 20.19 (Node.js 22 LTS recommended)
- npm 10+
- An IMAP/SMTP mailbox with an app password/authorization code if you want to connect a real account

## Quick start with the mock mailboxes

```bash
git clone https://github.com/Yingda-Yu/universal-email-mcp.git
cd universal-email-mcp
npm ci
npm run build

export EMAIL_MCP_CONFIG="$PWD/examples/mock-accounts.json"
export EMAIL_MCP_DATA_DIR="$(mktemp -d)"
node dist/index.js
```

The process speaks MCP over stdio. To explore it interactively, use [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  env EMAIL_MCP_CONFIG="$PWD/examples/mock-accounts.json" \
      EMAIL_MCP_DATA_DIR="$(mktemp -d)" \
  node dist/index.js --method tools/list
```

Inspector v2 does not forward arbitrary parent-process environment variables to the
stdio child, so pass them through `env` as shown above. Replace `--method tools/list`
with `--method tools/call --tool-name email_list_accounts` to call a tool.

### MCP client configuration

```json
{
  "mcpServers": {
    "universal-email": {
      "command": "node",
      "args": ["/absolute/path/to/universal-email-mcp/dist/index.js"],
      "env": {
        "EMAIL_MCP_CONFIG": "/home/you/.config/universal-email-mcp/accounts.json",
        "EMAIL_MCP_DATA_DIR": "/home/you/.universal-email-mcp",
        "EMAIL_ENABLE_SEND": "false"
      }
    }
  }
}
```

`EMAIL_ENABLE_SEND` is intentionally shown as `false`. Read the sending workflow below before changing it.

## Configuration

Configuration is read from `EMAIL_MCP_CONFIG`, defaulting to `~/.config/universal-email-mcp/accounts.json`. Use [examples/accounts.example.json](examples/accounts.example.json) as a template.

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "corp-a",
      "label": "Corporate mailbox",
      "email": "alice@corp.example",
      "provider": "imap-smtp",
      "preset": "netease-enterprise",
      "username": "alice@corp.example",
      "passwordEnv": "CORP_MAIL_PASSWORD",
      "send": { "enabled": false }
    }
  ]
}
```

- `id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` and is the only account identifier exposed to the model.
- Provide either `passwordEnv` (recommended) or `password`. Never commit a real password.
- With a preset, IMAP/SMTP endpoints are filled in for you. With `"preset": "custom"` you must supply explicit `imap` and `smtp` objects.
- `send.enabled` is a per-account second gate. It is `false` by default.
- `~/.config/universal-email-mcp/accounts.json` should be `0600`.
- The server does **not** load `.env` automatically. Export variables in the environment that starts the MCP server, or use your MCP client's `env` block.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMAIL_MCP_CONFIG` | `~/.config/universal-email-mcp/accounts.json` | Account configuration file |
| `EMAIL_MCP_DATA_DIR` | `~/.universal-email-mcp` | Local drafts and approval ledger |
| `EMAIL_ENABLE_SEND` | `false` | Global send switch; must be `true` together with the per-account flag |
| `EMAIL_RECIPIENT_ALLOWLIST` | unset | Comma-separated exact addresses and/or `@domain` entries |
| `EMAIL_SEND_RATE_LIMIT_PER_MINUTE` | `10` | Per-account send attempts per minute |
| `EMAIL_SEND_MAX_RECIPIENTS` | `20` | Maximum recipients across To/Cc/Bcc |
| `EMAIL_APPROVAL_TTL_SECONDS` | `900` | Approval lifetime (max 3600) |
| `EMAIL_ALLOW_PRIVATE_HOSTS` | `false` | Allow private/loopback mail hosts (development only) |
| `EMAIL_ALLOW_INSECURE_TRANSPORT` | `false` | Allow cleartext IMAP/SMTP on loopback hosts only (development only) |
| `EMAIL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`; logs go to stderr |

## Tools

| Tool | What it does |
| --- | --- |
| `email_list_accounts` | Lists configured accounts, their capabilities, verification status, and the current send policy. Credentials are never returned. |
| `email_list_folders` | Lists selectable folders for one account. |
| `email_list_messages` | Lists messages in a folder with cursor pagination, newest first. |
| `email_search_messages` | Server-side search by text with optional `since`/`before` date bounds and pagination. |
| `email_get_message` | Returns parsed headers, text body, attachments metadata, and optional sanitized HTML. Bodies are marked `untrusted-external`. |
| `email_get_thread` | Best-effort thread reconstruction from `Message-ID`, `In-Reply-To`, and `References`, with subject fallback. `complete` is always `false`. |
| `email_create_draft` | Stores a draft locally. Does not write to the provider and does not send. |
| `email_send_draft` | Sends a local draft after all send gates and a valid single-use approval token. |
| `email_reply` | Creates a reply draft with correct `Re:`, `In-Reply-To`, and `References` headers. It **never sends**. |

All tools accept JSON arguments and return JSON in the MCP text content. Errors use a stable shape:

```json
{
  "error": {
    "code": "MESSAGE_NOT_FOUND",
    "message": "Message was not found",
    "retryable": false,
    "details": {}
  }
}
```

Message and cursor values are opaque strings. Do not construct or edit them.

## Sending safety model

Sending requires all of the following:

1. `EMAIL_ENABLE_SEND=true` in the MCP server environment.
2. `"send": { "enabled": true }` on the account.
3. A valid `approval_token` for that exact draft.

The token is minted by a human in a separate terminal, using the bundled CLI:

```bash
# Development (TypeScript source)
npm run approve -- --account corp-a --draft drft_0123456789abcdef01234567 --approved-by "Alice"

# Built distribution
node dist/cli/approve.js --account corp-a --draft drft_0123456789abcdef01234567 --approved-by "Alice"
```

The CLI prints a token to stdout. Pass it to `email_send_draft`. Properties:

- Bound to the account, draft id, and a SHA-256 hash of the draft content.
- Single use. It is consumed before the SMTP attempt, so a failed send also burns the token.
- Default lifetime 15 minutes; maximum 1 hour.
- Stored only as a hash in `$EMAIL_MCP_DATA_DIR/approvals.json` (mode `0600`).
- The approval CLI and the server must use the same `EMAIL_MCP_DATA_DIR`.

The model cannot mint a valid token by asserting that a human approved the action. It must receive a token from an out-of-band human process. If an agent is able to run arbitrary shell commands in the same environment, treat the boundary as compromised: run the approval CLI outside the agent's shell context.

Recommended production settings:

```bash
export EMAIL_ENABLE_SEND=true
export EMAIL_RECIPIENT_ALLOWLIST="you@your-domain.example,@approved-partner.example"
```

## Providers

| Preset | IMAP | SMTP | Status |
| --- | --- | --- | --- |
| `netease-enterprise` | `imap.qiye.163.com:993` | `smtp.qiye.163.com:465` | documented, not live-verified |
| `alibaba-enterprise` | `imap.qiye.aliyun.com:993` | `smtp.qiye.aliyun.com:465` | documented, not live-verified |
| `tencent-enterprise` | `imap.exmail.qq.com:993` | `smtp.exmail.qq.com:465` | documented, not live-verified |
| `qq` | `imap.qq.com:993` | `smtp.qq.com:465` | documented, not live-verified |
| `netease-163` | `imap.163.com:993` | `smtp.163.com:465` | documented, not live-verified |
| `netease-126` | `imap.126.com:993` | `smtp.126.com:465` | documented, not live-verified |
| `custom` | explicit | explicit | configured |
| `mock` (provider) | local fixtures | local outbox | not applicable |

See [docs/provider-compatibility.md](docs/provider-compatibility.md) for the compatibility matrix, verification policy, and caveats.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, secret handling, SSRF/TLS rules, and reporting process. Highlights:

- Mail content is untrusted input. HTML is sanitized conservatively and the model is explicitly told never to follow instructions found in messages.
- Only `dist/index.js`, `dist/cli/approve.js`, and documented data files are written; the server does not open inbound ports.
- Logs go to stderr, never stdout, so they cannot corrupt the MCP stdio protocol.
- Passwords, tokens, authorization headers, and URL credentials are redacted from logs and error messages.
- `.env`, account files, drafts, and the approval ledger are excluded from git by `.gitignore`; the test suite contains only fictional `example.com` data.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

- `npm test` runs 142 unit/integration tests against in-memory IMAP/SMTP fakes and the mock provider. It never opens a network connection and never sends real email.
- `npm run inspect` starts MCP Inspector CLI against the built server, defaulting to `examples/mock-accounts.json` and the local `.email-mcp/inspect` data directory. Override with `EMAIL_MCP_CONFIG` and `EMAIL_MCP_DATA_DIR`.
- CI runs typecheck, lint, test, and build on Node.js 20 and 22.

## Known limitations in v0.1.0

- No outgoing attachments.
- Drafts are local only; they are not synced to the provider's Drafts folder.
- Gmail API and Microsoft Graph adapters are interfaces/stubs and throw `PROVIDER_NOT_IMPLEMENTED`.
- No OAuth, no IDLE/push, no flag updates, no folder creation/deletion.
- Thread reconstruction is best-effort and never claims completeness.
- The HTML sanitizer is a conservative defense, not a general-purpose sanitizer for rendering in a browser.
- No live provider has been verified. Do not describe the presets as "supported" in production without completing a live test.

## License

Apache-2.0. See [LICENSE](LICENSE).
