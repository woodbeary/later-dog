# Exact command allowlist

Choose **Always allow this command** on an eligible native approval card. The
composer has no approval menu and no allowlist dialog; the card is the only way
in.
Rules belong to that bot and provider instance across threads using the same
folder. They are not a filesystem sandbox, command prefixes or wildcard rules.
Full access is unchanged. Other commands keep the selected provider mode.

Claude Bash, Codex native shell approvals, and ACP execute requests can provide
the required structured input. If a provider omits a complete command or folder,
its existing approval UI remains. Questions, arbitrary MCP/computer operations
and requests to widen a provider sandbox cannot acquire a command rule. Only
owners/admins manage bot-wide rules. Rules stay on this installation; templates,
copies and workspace backups do not carry them to another bot or machine.

The focused tests cover the card's one atomic remember-and-allow action,
owner/admin gating and the existing once/session/peer choices:

```sh
pnpm exec vitest run src/components/PendingApproval.command-allowlist.test.ts src/components/ApprovalModeSelector.allowlist.test.ts
```

## Server and provider verification

```sh
pnpm exec vitest run server/command-allowlist.e2e.test.ts server/command-allowlist.test.ts server/auto-approve.test.ts server/workspace-backup-policy.test.ts
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/acp/acp.test.ts
```

The first test launches the real server in an isolated home, sends prompts to
its fake Claude CLI and raises requests through its actual native permission
socket. It asserts remembered/repeated/revoked commands, exact-match negatives,
folder isolation, owner/member permissions, stale cards, restart persistence
and decision receipts. Provider tests cover complete command transport,
questions/MCP exclusion and actual allow/deny outcomes (including ACP requests
with no allow option). Storage tests exercise bot/provider scope, disk failures
and malformed files. Backup policy tests exclude these installation-local rules.

These checks do not prove live-account model behavior or the Electron privileged
Full access bridge. See [Full Access verification](full-access.md) for its
independent regression coverage.
