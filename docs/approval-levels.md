# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread. Each level is one of the
provider's own permission modes, passed through. In the app the two everyday levels
are **Heel** (Ask for approval) and **Off-leash** (Approve for me); the others show
only where a dog already uses them. A native tool request that reaches you is one
the provider left for you. In Full Access, later.dog also applies its own
configuration tools without another approval.

You set a dog's level in its profile, or every dog's at once under Settings →
Computer → **Execution on this computer** in the desktop app. Both change the
same default and follow the same rules: a dog that uses this computer shows the
Off-leash warning first, a dog that is working keeps its level until its turn
stops, and Full access and Custom are only shown there for a dog that already
has them. The list is not shown on a paired remote client or in a browser.

Engines with no reviewer of their own (the free Kimi and Grok models, and other
OpenAI-compatible chat engines) get one app-side rule: Off-leash runs the tools of
the dog's own computer (its cloud computer, a Local VM or its own server) and
built-in browser without a card, while your own Mac, connected apps and custom
tools still ask before each action. Heel asks for every tool.

| Level | Behavior |
| --- | --- |
| **Heel** (Ask for approval) | Requests approval for commands and file changes, the way the provider's supervised mode does. |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval. Offered where the provider has such a mode (Claude, Grok, Antigravity). |
| **Off-leash** (Approve for me) | Uses the provider's automatic review on Codex, Claude, Cursor, and Grok to approve routine actions and ask about others. Chat engines without a reviewer run the dog's own computer and browser without asking, and ask about everything else, your Mac included. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Residual native permission prompts are answered for you. later.dog profile changes, routine actions, team setup, bot deletion, and enabled skill authoring apply without a second approval. Peer-review prompts are skipped within the bot's authorized scope. Delegation uses the receiving bot's setting, never the sender's — except from a Chief of Staff, whose level flows down (below). Actual questions and missing credentials still need your input. |
| **Custom (`config.toml`)** | Codex only. later.dog reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. They are hidden in
development, standalone web, and remote pages. Full access does not bypass operating
system privacy controls, authentication, CAPTCHA or MFA, service permissions,
or workspace/team ownership and computer-sharing grants. Full Access controls
approval prompts; it does not sign in for you, enable a feature you disabled,
or grant another bot access to a different workspace.

The effective setting belongs to the source conversation. An existing Ask
thread remains Ask even if the bot default is Full; a Full thread works without
these extra prompts even if the bot default is Ask. Ask, Auto, and Custom retain
their existing later.dog configuration review cards. Full actions return an applied
result and leave a settled receipt, so the bot continues in the same turn.
Invalid input, unavailable services, or failed writes return errors, not a
request to approve again. An expired native permission request is not turned
into another Allow/Deny card.

A turn a webhook, a routine, or another bot started runs in the bot's level
like any other turn. The decision log records that nobody was at the keyboard
when such a turn asked.

### Delegated work keeps the teammate's own level

Work one dog hands to another runs at the teammate's own level. The main dog
has no extra authority: its level never flows down to the dogs it asks.

### Your own Off-leash dogs work without you

A dog is **yours** when it works in your own workspace (not a hosted or
shared-sign-in workspace), in a conversation no guest drives. Messages from a
local tool on your Mac count as yours. Then three things carry your
authority, not only what you type: your routines, and what your
coordinator dog or any other of your dogs hands it (`send_to_bot`,
`ask_bot`, a room post and `coordinate_bots`). The handoff note
says "one of <your name>'s own dogs, passing on <your name>'s instructions"
instead of "not from your user".

An Off-leash dog of yours also gets a **standing grant**: you authorize it to
commit, push branches, commit and push to the default branch, open, update and
comment on pull requests, and run the repository's build, test and release
scripts (beta and over-the-air updates included) when you, your coordinator
dog, a routine or another of your dogs asks. The grant is in the dog's system
prompt, which Codex's reviewer reads as developer instructions, and Claude
Code's auto-mode reviewer gets it in the session's `--settings` as
`autoMode.environment` and `autoMode.allow` entries after `"$defaults"`. Claude
Code 2.1.293 lists both in `claude auto-mode config`. Whether a reviewer then
approves a given action is still its own decision. later.dog cannot overrule a
reviewer that denies outright. It only answers the actions a reviewer leaves
for you.

In a Cloud home, later.dog answers for your Off-leash dogs at once, with no
card and no wait:

- Every request the engine leaves for you is approved, including a sandbox
  exit, a sending tool and every action of a dog whose engine reviewer is off
  for its model or account. The chat gets no line per approval. The decision
  log records each one with source `owner-auto`.
- A question is never answered for you. The dog decides whether to ask; when
  it does, its question card waits for you, the same as everywhere else.
- Sends through a connected app (an email, a message, a post) go out with no
  "Send on your behalf?" card, for your Off-leash and Full access dogs alike,
  within the dog's daily limit (25 unless you change it under its
  Permissions). Code run through the catch-all workbench, which later.dog
  cannot read as one send, still asks.
- Only a small guard is refused, at once and with one plain line in the chat
  (decision log source `owner-guard`): force-pushing a repository's default
  branch (its `origin/HEAD`, or `main` and `master` when that is unknown),
  deleting a remote repository (`gh repo delete`, `DELETE /repos/{owner}/{repo}`,
  a tool that deletes a repository) and recursive deletes outside the dog's
  workspace or `/tmp`. A recursive delete whose target is a variable later.dog
  cannot see is refused too, with a request to write the literal path.

Nothing changes for Heel or Auto-accept edits dogs, guests and the
conversations they drive, hosted or shared workspaces, your Mac's own setting for `mac_*` and computer control, and a dog
changing another dog or your team. On a later.dog that runs only on your Mac,
your Off-leash dogs get the grant and the handoff authority, the reviewer's
requests still reach you as cards (a dog's Full access answers those), and
connected-app sends ask unless the dog's sends are set to Allow under its
Permissions.

Saved command approvals ("Always allow this command") belong to the dog,
command and folder. They keep matching after the dog moves to another account
of the same engine.

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
runs in from the CLI's `init` frame; when Approve for me was requested and the
session runs Manual, the chat shows one notice per session naming the model.
Choose a model the reviewer supports, Auto-accept edits, or Full access to
stop the prompts.

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

later.dog's built-in agents MCP server describes seven scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `check_delegation`, `wait_delegation`,
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
Antigravity automatic tool approvals on new and resumed Full access turns across
multiple model variants. It also checks that Ask and legacy Auto still prompt,
peer-started Full turns auto-approve, switching the receiving bot back to Ask
restores prompts even for a Full-access sender, delegated Codex Custom uses the
native Auto reviewer consistently, and questions remain interactive. Provider
processes are scripted fakes; this does not verify live account eligibility or
the quality of a provider's automatic reviewer. No live user data is used.
Grok coverage exercises two model selections across fresh/resumed Auto turns,
real built-in MCP reads under a scripted native reviewer, returning to Ask,
and held deletion, credential, spoofed-title command, and question requests.
