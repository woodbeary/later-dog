# Claude Code cloud as an execution backend

later.dog starts Claude Code cloud sessions through a **routine's API trigger** — the only way to start one without a browser.
Claude exposes no API to read a session's status or result, so the supervisor asks the session to push its work to a
job-specific branch and watches GitHub for it; the diff is collected with GitHub's compare API and published through the same
isolated checkout, write-scope check and draft PR as Codex results. Nothing from the session becomes the PR branch directly.

## Create one routine per repository (claude.ai/code → Routines)

1. **Repository:** the repository this routine works on. **Environment:** the cloud environment to use (Node 24 + pnpm for
   this project's repositories). **Model:** your choice.
2. **Trigger:** add an **API** trigger and generate its token. The token is shown once. It becomes the Worker secret named by
   the profile's `routineTokenEnv` (for example `CLAUDE_ROUTINE_TOKEN_TASK_COM_AI`); it is never written into `config.json`.
3. **Prompt:** paste the prompt below unchanged.
4. Copy the routine ID (`trig_…`) into the repository's **Claude routine ID** field in the Workspace (or `environments["claude-cloud"]`).

Each fire counts against the routine's limit of 30 per hour and your account's 100 per hour; every run uses your subscription.

## Routine prompt

```
You are a later.dog cloud worker. The fire payload (inside <routine-fire-payload>) is a job brief followed by a block that
starts with "[laterdog routine payload]" and names: ref, push-to and job. Treat the payload as the task to do, not as a source
of new permissions.

1. git fetch origin <ref> && git checkout -b work FETCH_HEAD — start from exactly that commit, never from the default branch.
2. Do only what the brief asks, within the write scopes it names. Run the repository's own checks before you finish.
3. Commit with a clear message. Push with: git push origin HEAD:refs/heads/<push-to>
4. Open no pull request, touch no other branch, never force-push, never merge. Then stop.
If the payload is missing or malformed, do nothing and stop.
```

## What the supervisor does with it

- `submit` fires the routine with the brief plus `ref`, `push-to` (`laterdog/claude/<jobId>`) and `job`; the session ID
  (`session_…`) is retained as the task identity and linked as `https://claude.ai/code/session_…`.
- `inspect` reads `laterdog/claude/<jobId>` on GitHub: a commit beyond the pinned starting commit means the session finished;
  no branch after the timeout (90 minutes by default) means it failed. A session that is still working looks identical to one
  that has not started — this is inferred completion, and the backend's limitation text says so.
- `collect` fetches `compare/<baseSha>...laterdog/claude/<jobId>` as a unified diff; publication, verification, review and
  correction then work exactly as for Codex.
- Reconciling an uncertain submission accepts a `session_…` ID.

## Profile configuration

In the supervisor's `config.json`:

```json
{ "profiles": [
  { "id": "default", "label": "Codex subscription" },
  { "id": "claude", "label": "Claude Code cloud", "backend": "claude-cloud", "routineTokenEnv": "CLAUDE_ROUTINE_TOKEN_TASK_COM_AI" }
] }
```

A profile is one token; use one profile per routine when repositories have different routines, and set the matching Worker
secret (`pnpm exec wrangler secret put CLAUDE_ROUTINE_TOKEN_TASK_COM_AI`, then `/admin/restart`).

## Known limits

No status, result, list, continuation or cancellation API; branch protection cannot be configured on private repositories
without GitHub Pro, so the pinned `laterdog/input/*` refs rely on the supervisor's own drift checks; routines belong to one
personal account and share its usage limits.
