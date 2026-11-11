# Provider compatibility

This document is a **compatibility matrix, not a support guarantee**. The v0.1.0 release ships a single generic IMAP/SMTP adapter and provider presets. Presets contain documented endpoints and defaults only; no vendor-specific behavior lives in the core.

## Status legend

| Status | Meaning |
| --- | --- |
| `not-applicable` | The mock provider does not use a network mailbox. |
| `documented` | Endpoints and authentication requirements are documented from vendor material, but this project has not completed a live end-to-end test. |
| `configured` | A custom account with operator-supplied endpoints. No vendor verification is implied. |
| `verified-live` | A maintainer has completed a live test against a real mailbox and attached redacted evidence to a pull request. **No preset currently has this status.** |

Simulated tests, unit tests, mocked IMAP/SMTP transports, and “it compiles” do **not** count as live verification. Never relabel a provider as verified without reproducible live evidence.

## Matrix

| Preset | Provider | IMAP | SMTP | Auth | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `netease-enterprise` | NetEase Enterprise Mail | `imap.qiye.163.com:993` TLS | `smtp.qiye.163.com:465` TLS | Account password or client-specific password | `documented` | Some tenants must enable IMAP/SMTP and client passwords in the admin console. |
| `alibaba-enterprise` | Alibaba Enterprise Mail | `imap.qiye.aliyun.com:993` TLS | `smtp.qiye.aliyun.com:465` TLS | Account password or client-specific password | `documented` | Tenant security policies may require a client-specific password. |
| `tencent-enterprise` | Tencent Exmail | `imap.exmail.qq.com:993` TLS | `smtp.exmail.qq.com:465` TLS | Account password or client-specific password | `documented` | Admins may need to enable IMAP/SMTP per account. |
| `qq` | QQ Mail | `imap.qq.com:993` TLS | `smtp.qq.com:465` TLS | Authorization code (app password) | `documented` | The normal account password will not work. Enable IMAP/SMTP in the web settings first. |
| `netease-163` | 163 Mail | `imap.163.com:993` TLS | `smtp.163.com:465` TLS | Authorization code (app password) | `documented` | Requires enabling IMAP/SMTP and generating a client authorization code. |
| `netease-126` | 126 Mail | `imap.126.com:993` TLS | `smtp.126.com:465` TLS | Authorization code (app password) | `documented` | Requires enabling IMAP/SMTP and generating a client authorization code. |
| `custom` | Any IMAP/SMTP server | explicit | explicit | explicit | `configured` | You must provide both `imap` and `smtp` endpoint objects. |
| `mock` | Local fixtures | none | local outbox | none | `not-applicable` | Used by the test suite and demos. |

All presets use `secure: true`, `requireTls: true`, and TLS 1.2 or newer. Cleartext transport on 993/465 is rejected at config load time.

## Configuration templates

All presets live in [examples/accounts.example.json](../examples/accounts.example.json). A single account looks like:

```json
{
  "id": "netease-a",
  "label": "NetEase Enterprise",
  "email": "alice@corp.example",
  "provider": "imap-smtp",
  "preset": "netease-enterprise",
  "username": "alice@corp.example",
  "passwordEnv": "NETEASE_ENTERPRISE_PASSWORD",
  "send": { "enabled": false }
}
```

Custom server:

```json
{
  "id": "internal-a",
  "label": "Internal mail",
  "email": "alice@internal.example",
  "provider": "imap-smtp",
  "preset": "custom",
  "username": "alice@internal.example",
  "passwordEnv": "INTERNAL_MAIL_PASSWORD",
  "imap": { "host": "mail.internal.example", "port": 993, "secure": true, "requireTls": true },
  "smtp": { "host": "mail.internal.example", "port": 465, "secure": true, "requireTls": true },
  "send": { "enabled": false }
}
```

## What a live verification must cover

Use a dedicated test mailbox that contains no customer or personal data.

1. `email_list_accounts` and `email_list_folders` succeed; the expected folders are visible.
2. `email_list_messages` returns a page and a valid `next_cursor`; the next page has no duplicates.
3. `email_search_messages` returns a known message with text and date filters.
4. `email_get_message` parses headers, text, and attachment metadata; HTML is not required.
5. `email_create_draft` creates a local draft and does not create a remote draft.
6. `email_reply` produces a local draft with correct `In-Reply-To` / `References`.
7. Sending is tested only if the operator explicitly wants it: enable both send gates, mint a token with the approval CLI, send to a controlled mailbox, and confirm exactly one message arrives.
8. Redact credentials, message bodies, and addresses before attaching evidence to a PR.

If a step fails, leave the status at `documented` and open an issue with the provider, the failing tool, the error code (not the raw credentials), and redacted logs.

## Known caveats

- **App passwords:** QQ, 163, and 126 require an authorization code, not the normal login password. Enterprise tenants may also require a client-specific password.
- **IMAP enablement:** several providers disable IMAP/SMTP by default. Enable it in the web/admin console before testing.
- **Tenant policies:** IP allowlists, device trust, and OAuth-only policies can block password-based IMAP/SMTP. Those tenants need a future OAuth adapter, not a preset change.
- **IMAP ID extension:** some Chinese providers expect the IMAP `ID` command. The current adapter relies on the underlying `imapflow` behavior; if a provider rejects login, capture the redacted error before changing code.
- **Folder names:** non-ASCII folder names use modified UTF-7 on IMAP. The transport/folder listing handles this through `imapflow`; do not hard-code encoded names.
- **Server-side search:** the IMAP adapter sends search criteria to the server. Providers differ in supported criteria and result ordering; the client-side result order is always newest-first by UID.
- **Attachments:** metadata is read, but v0.1.0 cannot send attachments.
- **Drafts:** local only. They are not written to the provider's Drafts folder.
- **Rate limits:** providers may throttle or temporarily block accounts after bursts. Keep `EMAIL_SEND_RATE_LIMIT_PER_MINUTE` low.
- **Gmail / Microsoft Graph:** reserved adapter modules exist and throw `PROVIDER_NOT_IMPLEMENTED`. They are not covered by this matrix.

## Custom servers

For a self-hosted or unlisted provider:

1. Use `"preset": "custom"`.
2. Supply explicit `imap` and `smtp` endpoints.
3. Keep `secure: true` and `requireTls: true`; the loader rejects cleartext on implicit TLS ports.
4. Private/loopback hosts are blocked unless `EMAIL_ALLOW_PRIVATE_HOSTS=true` is set for trusted local development.
5. Treat the account as `configured`, never `verified-live`, until the checklist above is completed.
