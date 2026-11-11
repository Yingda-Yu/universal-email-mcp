# Universal Email MCP — Architecture and MVP Specification

Date: 2026-11-11
Status: Proposed design for implementation
Repository: https://github.com/Yingda-Yu/universal-email-mcp

## Vision

Create a provider-agnostic, open-source Model Context Protocol (MCP) server that lets AI agents safely access users' email accounts. It is a general-purpose library and server, **not** a Jinhong-specific CRM. The first commercial user may be Jinhong, but no customer-specific information belongs in this public repository.

## Design choice

- Use TypeScript and the official MCP SDK; check the current SDK documentation and dependency versions before implementing.
- Implement a provider abstraction (`EmailProvider`) with capability discovery and typed operations.
- Implement generic IMAP/SMTP first; use configurable presets for NetEase Enterprise, Alibaba Enterprise Mail, Tencent Enterprise Mail, QQ, 163/126, and generic custom domains.
- "Preset available" does **not** imply verified compatibility. Publish a provider compatibility matrix with separate documented, configured, integration-tested and verified-live states.
- Reserve future first-class adapters for Gmail API/OAuth and Microsoft Graph/OAuth. Do not imply these adapters are already implemented.
- Offer stdio transport as the MVP. Add authenticated Streamable HTTP later after threat modeling.
- Never require Neon, a CRM, a web frontend, a cloud service or any real email credentials for local development and tests.

## Components

1. MCP tools: provider-neutral tool contracts, validated input/output, friendly errors, operation hints.
2. Account manager: per-account identifier, least-privilege configuration, no raw credentials returned to agents.
3. IMAP provider: list folders, list/search/read messages, message and thread metadata, pagination, bounded retrieval.
4. SMTP provider: send an email only when explicit approval and opt-in configuration are satisfied; support reply headers and RFC-compliant MIME.
5. Draft handling: local draft creation with unique IDs and explicit send confirmation; do not claim that a local draft is saved on a remote provider.
6. Safety layer: deny outbound messages by default, recipient allowlist for tests, rate limits, attachment and content size limits, no logging of sensitive bodies/tokens, anti-injection boundaries.
7. Test layer: deterministic fake IMAP/SMTP transports or mock servers; optional provider-specific integration tests requiring deliberate activation.
8. Packaging: npm executable, configuration example, Dockerfile (optional in MVP), lint/typecheck/test/build and GitHub Actions.
9. Documentation: bilingual README (English first, Chinese guide), quickstart, configuration, provider matrix, threat model, contributing guide, security disclosure policy.

## Initial MCP tools

- `email_list_accounts` (redacted, no credentials)
- `email_list_folders`
- `email_list_messages` (pagination, small default limit)
- `email_search_messages` (bounded server-side query; distinguish capabilities)
- `email_get_message`
- `email_get_thread` (best-effort grouping; clearly document provider limitations)
- `email_create_draft` (local draft unless provider expressly supports remote drafts)
- `email_send_draft` (requires an explicit confirmation token or trusted approval envelope; default disabled)
- `email_reply` (same confirmation path; no implicit sending)

Future work: attachment download/upload, labels/flags, remote drafts, OAuth, remote HTTP.

## Interface principles

- Every operation names `account_id`, avoiding ambiguous default accounts.
- Email identity: provider + account + folder + stable UID + UIDVALIDITY; do not treat bare IMAP UID as globally stable.
- Pagination, result limits and timeouts on reads.
- Structured errors for auth failure, unsupported capability, quota, timeout, ambiguous account, missing message, and approval denied.
- Handle malformed headers, character sets, HTML/plaintext, MIME attachments and encoded filenames. HTML should be returned as data, never instructions to the agent.
- Use Message-ID, In-Reply-To and References for replies; thread grouping can be imperfect for standard IMAP.
- SMTP submission acknowledgments do not guarantee final delivery; document asynchronous bounces.

## Non-goals in v0.1.0

- Mass email, automated prospecting and unsupervised outreach.
- Generic CRM integrations or customer classification.
- Open public remote MCP endpoints.
- Arbitrary third-party OAuth client registration.
- Guaranteed cross-provider search/thread parity.
- Claims of live-provider support without real verification.

## Required acceptance gates

1. `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.
2. MCP Inspector client can discover and call all implemented tools via stdio.
3. Tests cover account isolation, malformed MIME, folder/UID mapping, pagination, SMTP send failure, approval denial, SSRF-like configuration and TLS protections, secret redaction, MIME injection, and read-only behavior.
4. No default side effects: tests never send a real email; sending is disabled without explicit opt-in + confirmation.
5. Example environment config only uses placeholders; check tracked history and git diff for credentials.
6. Demonstrate two separately configured mock accounts and matching provider-neutral behavior.
7. CI must be green and documentation must distinguish demonstrated from planned functionality.
8. Open a PR against `main`; do not merge without owner approval.

## Proposed milestones

P0: repository scaffold, design, contracts, deterministic fake provider and tests.
P1: real IMAP/SMTP adapters, safe read/search/draft/send confirmation, MCP Inspector smoke tests.
P2: provider presets with documented verification, packaging, security review, CI and release candidate.
P3: OAuth providers + secure remote transport + explicit CRM integration examples after separate review.

## Open-source community

Apache-2.0 license already exists. Follow the actual license; add copyright notices where appropriate. Include CONTRIBUTING.md, SECURITY.md and provider contribution guidelines. Avoid logos/trademarks implying service-provider endorsement.
