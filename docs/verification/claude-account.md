# Claude account sign-out

Use only the disposable offline fixture. It never invokes a real Claude
executable or reads a real credential store.

```sh
node --experimental-strip-types scripts/verify-claude-account.ts
```

The launcher prints its API URL, preview URL, command log, disposable home,
and `failLogoutMarker`. Run Doctor against that exact API URL, then open the
preview. In Settings → General → Accounts, the synthetic **Claude review**
account is signed in as `ada@example.test`.

1. Choose **Sign out** on that row. Cancel once and confirm the identity
   remains.
2. Choose **Sign out** again and confirm. The fake CLI deliberately fails,
   leaving the account signed in. An error must appear under the row and
   **Sign out** must allow a retry.
3. Remove only the printed `failLogoutMarker` inside this disposable home.
   Retry. While pending, the button reads **Signing out…** and both it and
   **Remove** are disabled. When complete, the email disappears, the row reads
   **Not signed in**, and it offers **Sign in**.
4. Reload the preview and check the account remains signed out. The command
   log must show `auth logout` followed by `auth status --json`.
5. Close the preview and interrupt the launcher. It removes only its own
   temporary data and retains the printed server log.

The HTTP verification also checks cross-origin rejection, failed sign-out
preserving the synthetic account, successful retry, and an untouched sibling
account. Unit regressions cover a logout that ignores SIGTERM, disposal of
the controller/provider during logout, unknown auth-status results, and the
renderer using the confirmed response without a second catalog request.

```sh
pnpm exec vitest run --no-file-parallelism server/drivers/claude-login-auth.test.ts server/drivers/claude.test.ts server/provider-auth-sessions.test.ts server/request-auth.test.ts src/components/AccountsPanel.test.ts
pnpm typecheck
pnpm i18n:check
pnpm build
```

## UI evidence

The screenshot of the sign-out confirmation after a forced error, with the real
Settings surface still retryable, was removed from the repository on 2026-10-08.

This offline check does not prove a real Anthropic account login or OS
credential-store operation. No provider login was used for this review.
