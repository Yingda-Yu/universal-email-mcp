# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, mail content, or the send boundary.

Use GitHub's private vulnerability reporting on the repository Security tab, or contact the maintainers through the repository's private security advisory flow. Include:

- affected version and commit,
- the tool or module involved,
- a minimal reproduction with secrets removed,
- impact and any known workaround.

We will acknowledge the report, investigate, and coordinate disclosure. Please do not include real mailbox credentials, authorization codes, or customer message content in the report.

## Security model

### Untrusted email content

Messages, subjects, display names, HTML, and attachments metadata are untrusted external input. The server:

- marks message bodies with `content_trust: "untrusted-external"`,
- tells the model never to follow instructions found in messages,
- removes scripts, frames, forms, embedded styles, event handlers, and `javascript:`/`vbscript:` URLs from HTML,
- never executes or renders HTML itself.

The HTML cleanup is a conservative defense, not a general-purpose XSS sanitizer. Do not render returned HTML in a browser without an independent sanitizer.

### Sending boundary

Sending requires three independent conditions:

1. `EMAIL_ENABLE_SEND=true` in the server process.
2. `"send": { "enabled": true }` on the account.
3. A valid single-use `approval_token` bound to the account, draft id, and SHA-256 hash of the draft content.

Tokens are minted only by the separate `universal-email-mcp-approve` CLI. The model cannot mint, guess, or self-assert approval. Tokens:

- are stored in the approval ledger only as SHA-256 hashes,
- are compared in constant time,
- are consumed before the provider send attempt, so a failed send also burns the token,
- default to a 15-minute lifetime and are capped at 1 hour,
- are bound to the exact draft content; editing the draft invalidates the approval.

The ledger uses file locking and fails closed if it is corrupted or unreadable. The ledger and draft files are written with mode `0600`; directories use `0700`.

**Caveat:** if an AI agent can execute arbitrary shell commands in the same environment, it could potentially read the approval CLI output or the ledger. Run the approval CLI outside the agent's shell context. The approval boundary protects against a model claiming approval; it does not defend against a fully compromised host.

Additional guardrails:

- Per-account send rate limiting (`EMAIL_SEND_RATE_LIMIT_PER_MINUTE`).
- Optional recipient allowlist, exact addresses or `@domain` entries (`EMAIL_RECIPIENT_ALLOWLIST`).
- Maximum recipient count (`EMAIL_SEND_MAX_RECIPIENTS`).
- Every send attempt is serialized per account.

### Secrets

- Use `passwordEnv` rather than inline passwords.
- Configuration is read from `EMAIL_MCP_CONFIG`; the default path is `~/.config/universal-email-mcp/accounts.json`.
- The repository `.gitignore` excludes `.env`, account files, drafts, approval ledgers, and build outputs. Never commit real credentials.
- Logs are JSON on stderr. `password`, `passwd`, `token`, `secret`, `api_key`/`apiKey`, bearer/basic authorization values, and URL-embedded credentials are redacted. Error messages pass through the same redaction.
- Tool results never include account passwords or usernames. `email_list_accounts` exposes only public account metadata.
- The test suite uses fictional `example.com`/`example.org` data and in-memory transports. It never opens a network connection.

Recommended file permissions:

```bash
chmod 700 ~/.config/universal-email-mcp
chmod 600 ~/.config/universal-email-mcp/accounts.json
chmod 700 ~/.universal-email-mcp
```

### Network and transport security

- `secure: true` and `requireTls: true` are the defaults for IMAP and SMTP.
- Cleartext transport is rejected on implicit TLS ports (993/465).
- Cleartext is allowed only for loopback hosts and only with `EMAIL_ALLOW_INSECURE_TRANSPORT=true`; this is intended for local development.
- SMTP requires STARTTLS when a connection is not already TLS, rejects unauthorized certificates, and uses TLS 1.2 or newer.
- IMAP hostnames are DNS-resolved before connecting; private, loopback, link-local, and cloud metadata addresses are blocked unless `EMAIL_ALLOW_PRIVATE_HOSTS=true`.
- Hostnames containing schemes, ports, credentials, or metadata service names are rejected during config loading.
- There is no inbound listener. The server communicates over stdio only.

### Input validation and injection

- All MCP arguments are validated with Zod schemas at the protocol boundary and again in the core.
- Subjects, folder paths, addresses, Message-ID headers, and search queries reject CR/LF and control characters.
- Folder traversal (`..`, absolute paths) is rejected.
- Message and draft identifiers are constrained to opaque server-generated formats.
- Body sizes, recipient counts, message references, and page sizes have hard limits.
- SMTP file/URL access is disabled in the transport, preventing local file or URL injection into messages.

### Data at rest

- Drafts live under `$EMAIL_MCP_DATA_DIR/drafts/<account-id>/` as JSON, `0600`, written atomically via a temporary file and rename.
- Each draft stores a content hash; loading a modified draft fails with `DRAFT_CONTENT_CHANGED`.
- The approval ledger lives at `$EMAIL_MCP_DATA_DIR/approvals.json`, `0600`, and contains token hashes, not raw tokens.
- There is no encryption at rest in v0.1.0. Use full-disk encryption if the host stores sensitive mail.

### What the server does not protect against

- A compromised host, compromised Node.js runtime, or malicious dependency.
- A human approving a draft without reading it.
- Recipients or providers that mishandle mail after delivery.
- Vulnerabilities in provider servers or in `imapflow`, `nodemailer`, or `mailparser`.
- Rich HTML that is safe for the model but unsafe for a browser; re-sanitize before rendering.
- The model summarizing untrusted content incorrectly. Treat summaries as model output, not ground truth.

## Operational checklist before enabling send

1. Read this document and `README.md`.
2. Start with `EMAIL_ENABLE_SEND=false` and verify read/search/draft tools.
3. Configure `EMAIL_RECIPIENT_ALLOWLIST` for the intended recipients.
4. Keep `EMAIL_SEND_RATE_LIMIT_PER_MINUTE` conservative.
5. Enable send only for a dedicated account.
6. Run the approval CLI outside the agent's shell.
7. Monitor stderr logs for `SMTP_SEND_FAILED`, `AUTHENTICATION_FAILED`, `RATE_LIMITED`, and `APPROVAL_*` events.
8. Rotate the mailbox password/authorization code immediately if you suspect exposure.

## Dependency and release hygiene

- CI runs typecheck, lint, tests, and build on Node.js 20 and 22.
- Release artifacts are built from the tagged source; `dist/` is not committed.
- Review dependency updates before merging. The mail stack (`imapflow`, `nodemailer`, `mailparser`) handles untrusted network data, so security updates should be applied promptly.
