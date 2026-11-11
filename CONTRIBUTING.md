# Contributing

Thanks for improving universal-email-mcp. This project handles credentials and the ability to send mail, so contributions are reviewed with security in mind.

## Development setup

```bash
git clone https://github.com/Yingda-Yu/universal-email-mcp.git
cd universal-email-mcp
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Requirements: Node.js >= 20.19 and npm 10+.

## Branches and commits

- Never commit directly to `main`. Open a pull request.
- Use focused branches such as `feat/...`, `fix/...`, or `docs/...`.
- Keep commits small and describe the intent. Conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`) are welcome but not mandatory.
- Rebase or merge from `main` before marking a PR ready.

## Pull request checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] New behavior has tests.
- [ ] No real credentials, addresses, domains, or message content are included.
- [ ] No test opens a network connection or sends real email.
- [ ] Security-relevant changes update `SECURITY.md` and/or `docs/provider-compatibility.md`.
- [ ] Provider support claims are backed by live evidence; otherwise the status stays `documented` or `configured`.

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Provider-agnostic domain logic: errors, validation, MIME parsing, threading, drafts, approval ledger, send policy, redaction, logging. |
| `src/config/` | Zod config schema, loader, provider presets. |
| `src/providers/` | `EmailProvider` implementations: IMAP/SMTP adapter, mock provider, Gmail/Graph stubs. |
| `src/tools/` | MCP tool schemas, handlers, registration and response mapping. |
| `src/server.ts` | MCP server assembly and instructions. |
| `src/cli/approve.ts` | Human-only approval token CLI. |
| `test/unit/` | Pure unit tests. |
| `test/integration/` | Mock provider, fake IMAP/SMTP, and MCP protocol tests. |

The core must stay provider-agnostic. Do not hard-code a vendor, tenant, hostname, or customer name in `src/core/`, `src/tools/`, or `src/server.ts`. Vendor endpoints belong in `src/config/presets.ts` or user configuration.

## Adding or changing a provider preset

1. Add or update the preset in `src/config/presets.ts` with documented IMAP/SMTP endpoints and `status: 'documented'`.
2. Update `docs/provider-compatibility.md` and `examples/accounts.example.json`.
3. Add a config loader test for endpoint resolution.
4. Do not set `verified-live` without a live test. Include redacted evidence in the PR description: provider, date, tools exercised, error codes if any, and confirmation that no secrets or message bodies are exposed.
5. Provider-specific quirks belong in the adapter or transport, not in the tool handlers.

## Adding a new tool

- Define the input shape in `src/tools/schemas.ts`.
- Implement the handler in `src/tools/handlers.ts` with explicit `EmailMcpError` codes.
- Register it in `src/tools/register.ts` with a description and safe annotations.
- Add JSON-response mapping that never leaks secrets.
- Add unit/integration coverage, including an invalid-input case and an error-code case.
- Update the tool table in `README.md` and `README.zh-CN.md`.

## Tests and fixtures

- Use `test/helpers/harness.ts` for multi-account tool tests.
- Use `test/helpers/fake-imap.ts` for IMAP adapter tests.
- Use `test/helpers/raw-email.ts` for MIME fixtures.
- Only fictional domains (`example.com`, `example.org`, `example.net`, `.example`) and fake data are allowed.
- Never add a test that requires credentials, a live mailbox, or outbound network access.

## Security changes

If you change the approval ledger, send policy, TLS handling, SSRF checks, redaction, MIME parsing, or HTML sanitization, explain the threat model in the PR. Include negative tests proving the bypass is blocked. Do not weaken defaults for convenience.

## License

By contributing, you agree that your contribution is licensed under the Apache-2.0 License.
