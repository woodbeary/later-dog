# An edit forks the engine's own session, November 20

After an edit or a rewind, the next turn used to start a fresh engine session and replay the
kept messages to it as text. That kept the dropped reply out, but the replay was not cached and
the engine lost its own tool calls and results. Now, when it can, later.dog forks the engine's
own session at the end of the last kept turn:

- Claude Code 2.1.316 or newer: `--resume <kept session> --fork-session --session-id <new>
  --resume-session-at <last entry of the kept turn>`.
- Codex: `thread/fork` with `lastTurnId` set to the last kept turn. The fork is used only if the
  thread it returns ends at that turn; otherwise it is dropped and the turn starts a new thread.

Every engine turn that finishes records where it ended (the Claude chain entry or the Codex turn
id) against the last message the engine saw, in `engine-forks.json` in the data folder. A fork is
used only if, walking back from the end of the kept path past activity rows and digests, the first
message the engine would have seen is one a turn ended on. A kept path that ends partway through a
turn, or that has anything the engine never saw after its last turn, gets today's text replay.
That replay is also what a failed fork falls back to, and what an older Claude Code gets.

## Recipe

`pnpm exec vitest run server/rewind-native-fork.e2e.test.ts` runs four fixtures and writes
`.laterdog-evidence/rewind-native-fork/`:

- Claude (`FAKE_CLAUDE_VERSION=2.1.316`, `FAKE_CLAUDE_CHAIN_DIR`): two turns, then the second message
  is edited. The fake engine logs a fork from the old session at the kept turn's last entry. The edited
  turn runs in the new session with the plain edited text (no replay preamble). Its history is the
  kept prompt, reply, `echo hi` call and `hi` result, with nothing of the dropped turn. A follow-up
  resumes the forked session.
- Claude on 2.1.270: no fork; the edited turn gets the text replay with no trace of the dropped turn.
- Codex (`FAKE_CODEX_THREAD_DIR`): `thread/fork` keeps one turn, the edited turn runs on the fork and
  sees only the kept turn, and the follow-up resumes the fork.
- Codex whose fork ignores `lastTurnId` (`FAKE_CODEX_FORK_IGNORES_TURN=1`): the fork comes back with
  both turns, later.dog drops it, and the edited turn starts a new thread with the text replay.

## Real Claude Code 2.1.316, no account

The installed CLI was run against a local stand-in for the Messages API (throwaway config folder,
a dummy key the stand-in ignores). Two turns, `KEEP_REQUEST` then `ABANDONED_REQUEST`, then a fork
at the first turn's assistant `uuid` from stream-json, with `REPLACEMENT_REQUEST`. The request the
fork sent held `KEEP_REQUEST`, `KEEP_REPLY` and `REPLACEMENT_REQUEST`, nothing of the dropped
turn, under the new session id. Its first two messages and system prompt were byte-identical to
the original session's second request, with a `cache_control` mark, so the kept part is a cache
prefix. The stand-in does not cache, so no cache hit was measured.

## Limits

- No live engine account was used; Codex was checked only against the fake app-server.
- A Claude engine placed on a dog's cloud computer stays on the home for a forked turn.
- Fork points from before this change do not exist, so the first edit in an older chat still replays.
