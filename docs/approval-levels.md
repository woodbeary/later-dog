# Approval levels

## Auto-review: one switch for your dogs

Settings → General → **Dogs** → **Auto-review** decides how every one of your
own dogs works. There is no per-dog Heel or Off-leash picker any more.

| Auto-review | What your dogs do |
| --- | --- |
| **On** | The engine's own AI reviewer checks each step (Codex `auto_review`, Claude `auto`, Cursor `--auto-review`, Grok `auto`). You see a card only for what the reviewer leaves for you. Engines without a reviewer (the free Kimi and Grok models, OpenAI-compatible chat engines) card each request, and the chat says so once; the chat engines still use the dog's own cloud computer and browser with no card, and a computer the person has taken over refuses the dog's call. |
| **Off** | No asks. The engine still starts with its reviewer, and later.dog answers whatever it leaves for you at once, with no card. The decision log records each one with source `owner-auto`. |

The switch is saved in the config as `features.autoReview` and changed with
`PATCH /api/config`. It is set once on the first start that has the switch. On
a Cloud home it starts off when any dog was already Off-leash, because there
those dogs already worked without asking. Everywhere else it starts on,
including a new install and a Mac whose dogs were Off-leash, because on a Mac
Off-leash already meant the engine's reviewer decided and its escalations
became cards. A dog's saved `approvalMode` no longer
changes how your own dogs work, except **Full access** and **Custom**, which
keep their own behaviour.

With either setting:

- A question is never answered for you. The dog decides whether to ask; when it
  does, its card waits for you.
- Only a small guard is refused, at once and with one plain line in the chat
  (decision log source `owner-guard`): force-pushing a repository's default
  branch (its `origin/HEAD`, or `main` and `master` when that is unknown),
  deleting a remote repository (`gh repo delete`, `DELETE /repos/{owner}/{repo}`,
  a tool that deletes a repository) and recursive deletes outside the dog's
  workspace or `/tmp`. A recursive delete whose target is a variable later.dog
  cannot see is refused too, with a request to write the literal path.
- A routine a dog sets up, for itself or for another of your dogs, applies at
  once with an Undo on its receipt. There is no limit on how many routines a
  dog keeps, and no Confirm card. later.dog's own tools are pre-allowed on
  every engine, so the engine's reviewer does not see them.
- Sends through a connected app (an email, a message, a post) go out with no
  card in a Cloud home while Auto-review is off, and always for a Full access
  dog. While it is on, a send shows one "Allow Gmail?" card (Allow once, Skip,
  Always allow); Always allow is remembered for that dog and app.

A dog is **yours** when it works in your own workspace (not a hosted or
shared-sign-in workspace), in a conversation no guest drives. Messages from a
local tool on your Mac count as yours. Your routines and what your other dogs
hand a dog (a room post and `coordinate_bots`) carry
your authority; the handoff note says "one of <your name>'s own dogs, passing on
<your name>'s instructions" instead of "not from your user".

The dog's system prompt says so in one neutral sentence: it is one of your own
dogs, and what you ask and what your routines and other dogs pass on carries
your authority. Claude Code's auto-mode reviewer also gets a **standing grant**
in the session's `--settings` as `autoMode.environment` and `autoMode.allow`
entries after `"$defaults"`: you authorize your dogs to commit, push branches,
commit and push to the default branch, open, update and comment on pull
requests, and run the repository's build, test and release scripts. Whether a
reviewer then approves a given action is still its own decision; later.dog
cannot overrule a reviewer that denies outright.

Guests, the conversations they drive, and hosted or shared workspaces keep each
dog's saved level, and a guest-driven turn always runs as Heel. In a shared
workspace, turning on Off-leash for a dog that uses the server's own computer
still needs `acknowledgeLocalAuto: true`.

## Your Mac: a choice per Mac

Each Mac connected to your Cloud home has its own choice, under Settings →
Computer → **Your Macs**:

| Choice | What happens when a dog wants to use that Mac |
| --- | --- |
| **Always allow** (the default) | It goes ahead with no card. |
| **Ask every time** | A card names the Mac and what the dog wants (the folder, file, command or app). **Allow once** covers that kind of action for the rest of the same request, **Always allow** switches that Mac to Always allow, and **Never** switches it to Never and refuses this one. These are the only three choices. In a group chat the card offers Allow once and Never. |
| **Never** | The call is refused with no card, and the dog says so in one line. |

The choice is saved in `mac-access.json` (`{ version: 2, mode, computers }`,
where `mode` is the choice for a Mac with none of its own) and read and changed
with `GET` and `PUT /api/mac-access` (the owner's own devices only; `PUT` takes
`{ computers: { "<mac id>": "ask" | "always" | "never" } }`). A first-version
file moves over once: Never stays Never, and Ask, which never asked the owner,
becomes Always allow. Auto-review does not change this choice.

Saved command approvals ("Always allow this command") belong to the dog,
command and folder. They keep matching after the dog moves to another account
of the same engine.

## Levels underneath

Each level is one of the provider's own permission modes, passed through. The
switch above runs your dogs as **Off-leash** (`auto`); the others stay for
guests, shared workspaces and dogs that already use them.

| Level | Behavior |
| --- | --- |
| **Heel** (Ask for approval) | Requests approval for commands and file changes, the way the provider's supervised mode does. |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval. Offered where the provider has such a mode (Claude, Grok, Antigravity). |
| **Off-leash** (Approve for me) | Uses the provider's automatic review on Codex, Claude, Cursor, and Grok to approve routine actions and ask about others. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Residual native permission prompts are answered for you. later.dog profile changes, routine actions, team setup, bot deletion, and enabled skill authoring apply without a second approval. Actual questions and missing credentials still need your input. |
| **Custom (`config.toml`)** | Codex only. later.dog reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. Full access does not
bypass operating system privacy controls, authentication, CAPTCHA or MFA,
service permissions, or workspace ownership and computer-sharing grants.

## Answering a request

Approve or deny requests in the conversation to let the bot continue. **Allow
once** answers this request only. **Always allow this session** hands the
provider its own remembered approval: Claude receives its suggested permission
rules, and ACP agents such as Grok receive their `allow_always` option, or the
driver repeats your answer for that exact operation until the native session
ends. later.dog keeps no standing grant for a provider's tool. It is not
offered for computer control or for a sandbox change.

Auto-accept edits and Ask card whatever the provider asks about. Approve for
me cards whatever the provider's reviewer leaves for you, with the note "The
provider requires your approval for this action." A sandbox widening is held
in every level but Full.

### When the native reviewer never starts

Claude Code accepts `--permission-mode auto` for every model and, when auto
mode is unavailable to the session, starts in Manual without an error. On
Claude Code 2.1.266 that is the case for Claude Haiku 4.5 and Sonnet 4.5,
and for any organization that set `disableAutoMode`. In that session the bot
asks before each action. The Claude driver reads the mode the session actually
runs in from the CLI's `init` frame; when Auto-review is on and the session
runs Manual, the chat shows one notice per session naming the model. Choose a
model the reviewer supports, or turn Auto-review off, to stop the prompts. With
Auto-review off later.dog answers those requests and shows no notice.

### Antigravity: Ask, Edits, or Auto (full access)

For Antigravity, the composer and bot settings offer **Ask for approval**,
**Auto-accept edits** (its native `auto_edit` mode), and **Auto (full access)**.
Auto enables native `yolo` mode and automatically approves remaining
tool-permission requests for commands, edits, and computer actions, without an
automatic reviewer. The composer chip reads **Auto**. This uses the existing
Full access grant and confirmation, not a separate permission setting, and
applies to every model in that Antigravity instance, including Gemini.

Choose Auto explicitly in the local packaged desktop app. Old Antigravity
`auto` / `autoApprove` settings still behave as Ask and are displayed as Ask;
they never become unrestricted access on upgrade. Switching back to Ask
restores prompts on the next turn. Questions and missing-credential forms
still require an answer. Another dog
can delegate work to this bot without downgrading its explicit Auto
(full access) grant. It does not enable Auto on any other bot.

## Asking you questions

Every engine can stop and ask, and no approval level answers a question for
you: Ask, Auto-accept edits, Auto, and Full access all leave a question card
for a person. What differs per engine is only how the ask travels:

| Engine family | How an ask travels | Multiple questions at once |
| --- | --- | --- |
| Claude Code | Structured round-trip (its own `AskUserQuestion`) | Yes — capped at 4 by the CLI |
| Codex | Structured round-trip | Yes — up to 6 |
| Grok Build, Minimax, OpenAI-compatible endpoints | The injected `ask_user` tool | Yes — up to 6 |
| ACP engines (Cursor, Antigravity, Gemini CLI, Qwen Code, OpenCode, …) | Option-match round-trip on the ACP permission request | One at a time — the request carries one choice set |
| Pi | Free-text round-trip over `extension_ui_request` | One at a time |

Older conversations may still hold a question the removed Computer engine
parsed out of model-authored output rather than a real tool call. Those
cards keep their "Agent-composed question" badge, and their decision-log
rows keep `origin: output`. Flat clients (notifications, older companion builds)
see plain buttons only when a card asks a single choice question; a
multi-question card renders its structured form on current apps instead.

## Provider mappings

| Provider | Ask | Auto-accept edits | Auto | Full access |
| --- | --- | --- | --- | --- |
| Codex | `on-request` approvals, `workspace-write` sandbox, you review | not offered (Ask already writes in the workspace) | same sandbox, native `auto_review` reviewer | `never` approvals, `danger-full-access` sandbox |
| Claude | Native `default` | Native `acceptEdits` | Native `auto` | Native `bypassPermissions` |
| Cursor | Native default | not offered | Native `--auto-review` | Native `--force` |
| Antigravity | Native `default` | Native `auto_edit` | Legacy `auto` behaves as Ask; UI Auto selects Full access | Native `yolo` plus automatic approval of remaining tool-permission requests; shown as Auto |
| Grok Build | Native `default` | Native `acceptEdits` | Native `--permission-mode auto`; availability of Grok's reviewer depends on its feature rollout | Native `bypassPermissions` plus automatic approval of remaining tool-permission requests |
| OpenCode | Ask | not offered | Ask | Approve individual ACP permission requests, never task questions |
| Qwen Code | Native `default` | Native `--approval-mode auto-edit` | Native `--approval-mode auto` (Qwen's LLM classifier approves safe actions, blocks risky ones) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Gemini CLI | Native `default` | Native `--approval-mode auto_edit` | Ask (no reviewer) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Other/custom engines | Ask | not offered | Ask | Not offered until a provider mapping is implemented |

These settings apply on each turn, including resumed conversations. Switching
to a different provider while elevated requires leaving Full/Custom first;
choose Ask. Switching models within Antigravity keeps the selected level.
Native modes require a CLI version that supports them; later.dog does not
silently substitute unrestricted access when a mode is rejected.

### Read-only integration tools

later.dog's built-in agents MCP server describes its scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_shared_computers`, `tool_result_read`,
`session_search`, `session_read`, `list_routines`, and `skills_list`.
Session recall still enforces own-bot access and records its existing room
disclosure audit. These hints do not grant access to another bot's conversations.
Writes, credential requests, proposals, and third-party tools do not inherit
these hints. The metadata is available to every engine using this integration;
whether an engine consumes it remains that engine's behavior. Arbitrary MCP
display titles or `readOnlyHint` claims from a third-party server are not
authorization to bypass a prompt.

The level set follows the provider-boundary approach in
[T3 Code's permission modes](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/permission-modes.md):
Supervised, Auto-accept edits, Auto, and Full access, each a provider mode
rather than an app rule, with a remembered approval that belongs to the
provider's session. Its quieter default is Full access; later.dog keeps its
own opt-in desktop confirmation and Ask as the default.

## Verification for contributors

The [Full Access workflow recipe](verification/full-access.md) tests immediate
profile, routine, team, skill, and peer actions through the real server and MCP
proxy. Its fixture also verifies that explicit Ask sibling threads still wait.

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
HTTP elevation rejection, Full → Auto → Ask on resumed Claude turns, and
Full applied to existing Claude, Codex and Grok threads. It also checks that
Ask and legacy Auto still prompt, delegated Codex Custom uses the native Auto
reviewer consistently, and questions remain interactive. Provider
processes are scripted fakes; this does not verify live account eligibility or
the quality of a provider's automatic reviewer. No live user data is used.
Grok coverage exercises two model selections across fresh/resumed Auto turns,
real built-in MCP reads under a scripted native reviewer, returning to Ask,
and held deletion, credential, spoofed-title command, and question requests.
