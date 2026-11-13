# Always allow

Every permission card offers **Allow once**, **Don't allow** and **Always allow**.
Always allow is kept on the dog, not on one chat: it holds in every chat of that
dog, in work it does for a teammate, for its helpers, after a restart, after its
engine session is rebuilt and on whichever account or engine it runs. When an
engine asks for something the dog is already allowed, the home answers "allow"
itself and no card is raised; nothing relies on an engine's own session rules.

## What a grant covers

One function, `grantKeyFor` in `server/laterdog/always-allow.ts`, turns a request
from any engine into its key:

| Request | Key |
|---------|-----|
| A shell command (Claude Bash, Codex shell, ACP execute) of a program with subcommands | `run:git push`, `run:npm run`, `run:docker compose` |
| A package runner | `run:npx prettier`, `run:pnpm dlx create-vite` |
| Any other single program | `run:ls`, `run:rm` |
| A compound or wrapped command, an interpreter, inline code, an env prefix, a path program, a flag that runs another program, or a path outside the dog's folders | `exact:<the command text>` |
| A file edit (Claude Edit/Write/MultiEdit/NotebookEdit, Codex edit, ACP edit) whose every path is inside the dog's folders | `files:edit` |
| A named tool (`mcp__server__tool`, Codex MCP tool, `WebFetch`) | `tool:server/tool`, `tool:webfetch` |
| A connected app's tool | `connector:<app>:<tool>` |
| Any of the above on the person's own computer | `computer:` + the key |

The dog's folders are its working folder, its chat folders and its home folder,
resolved through links; the home directory and `/` never count.

No key, so no Always, for: paying or buying, sending an email or a text as the
person (by tool name or by `mail`, `sendmail`, `osascript` and the like in a
command), deleting outside the dog's folders, editing a file outside them, a
command holding a secret or longer than the key limit, a sandbox escape or any
request policy marks as needing explicit approval, a request the engine cannot
name (ACP `other`/`read`/`delete`/`move`, Pi confirmations, Codex whole-app
access), and every request in a guest's turn. A guest, and a member who is not
an admin in a shared installation, cannot give a lasting approval.

The owner's safety holds stay: before answering from a grant the home runs the
owner guard on the request; force-pushing a default branch, deleting a remote
repository or deleting recursively outside the dog's folders raises a card
unless that hold's own key is granted. A program key never covers the person's
computer (`computer:` keys are separate), and Mac control keeps its own
per-computer choice.

## The wire

A card carries `allowKey` when Always is offered and `forDog` when the dog
works for another dog. A client answers with `POST /api/threads/:id/respond`
and `{ "requestId", "behavior": "allow", "scope": "always" }`; the home stores
the card's key on the asking dog. Older clients that post
`/api/bots/:id/always-allow` first and then answer keep working, and a plain
`{ "behavior": "allow" }` is Allow once. `DELETE /api/bots/:id/always-allow?key=`
removes a key from the dog and every chat copy; a `PATCH` of the dog's
`alwaysAllow` also removes dropped keys from every chat.

## Proof

```sh
pnpm exec vitest run server/laterdog/always-allow.test.ts server/laterdog/always-allow-answer.test.ts \
  server/laterdog/connector-ask.test.ts src/lib/allowed.test.ts
pnpm exec vitest run server/laterdog/always-allow.e2e.test.ts
```

The first set covers the key table with requests shaped as each engine's driver
sends them, the lookup (dog-wide, a teammate's thread, after a restart, an older
chat-stored key, removal from the dog and every chat copy), the guest and member
refusals, and the owner guard holding under an exact grant. The end-to-end test
launches the real server with the fake engine and raises requests through its
native permission socket: a card with `run:git push`, Always answered once, the
same program in the same chat, in another chat and after a restart answered by
the home with no card, a different program still asking, Allow once asking
again, an email send offering no Always, an edit inside the chat folder
remembered as `files:edit` and one outside offering no Always, and a removed
key asking again.

Not proven with a real engine: the paths Codex and ACP engines report for
edits, Codex MCP tool names (they carry no server name), and whether an
engine's own session rules ask less often on top.
