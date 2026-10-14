# Token battery

Several Claude or ChatGPT (Codex) subscription accounts, used one after another. You add each account in Settings → General → Accounts (Add account) with **Keep going when an account runs out** enabled automatically once two eligible subscription accounts are connected. An explicit off stays off. When the account a conversation runs on reaches its usage limit, later.dog continues the conversation on the next available account in your full list, and the conversation goes back to its own account once that limit resets. When every account it can use is out, it waits and picks up where it stopped as soon as the first limit resets, so you can walk away. The list can continue from Claude to Codex or back. Across engines, the receiving account uses the model the dog chose for that engine in its Backup models (matched to that account, or to any account on that engine), else the engine's default model, and does not inherit an incompatible effort or variant. When the move changes engine, the chat gets one short line: "Claude is recharging. Continuing on Codex." ("Running on Codex." when a new message starts there). Your saved conversation and bot selections stay unchanged.

You can turn automatic continuation off at any time. Turning it off while work waits cancels that automatic pickup and leaves a visible notice.

## Turning it on

**Keep going when an account runs out** is one setting, switched from any of three places:

- Settings → General → Accounts, below Add account;
- the model picker's first page, below its accounts;
- the message a conversation gets when its account runs out.

The order is the complete Accounts list, stored as `accountBattery.sequence`. Older settings fall back to the saved per-engine order with newly connected accounts appended. Automatic order ranks the entire list by remaining usage, preserving saved order for ties. To change it, drag an account up or down in the model picker's account list or in Settings → General → Accounts. With the keyboard, focus the account in the model picker and press Alt+↑ or Alt+↓, or focus its handle in Settings and press ↑ or ↓. The new order is saved at once, whether the switch is on or off. Dragging needs a mouse or trackpad. Removing an account takes it out of the order. Each account shows how much its tighter limit has left, as a ring or bar that drains as you use it, or **Not signed in**. A resting account sleeps, with a charging indicator that recharges from when it ran out until it is **Back at** the reset (**Back around** when the reset is only estimated). Two configuration folders signed in to one Anthropic login share one limit, and rest together.

Saved in `config.json`:

```json
{ "accountBattery": { "enabled": true, "order": { "claudeAgent": ["claude", "claude-1f2e…"], "codex": ["chatgpt", "chatgpt-9a7c…"] } } }
```

Only Claude and ChatGPT accounts on a personal subscription login are in the battery. Claude through an API key, an account signed in with an API key, a router or other custom endpoint, an engine your organization manages, and an engine its policy refuses are never used by it.

## Which account a turn runs on

Each turn runs on the first of these that can take it:

1. the account picked with **Continue on** in the limit message, while the account that ran out still rests and until another account is picked in the model picker;
2. the account the conversation names (its model selection), when it is enabled, not known to be signed out and not resting;
3. with the switch on, the first account in the order that is enabled, not known to be signed out, not resting, and offers the turn's model for that engine, or its own default model when switching engines.

If every account rests, the turn runs on the account the conversation names and reports the limit again.

The choice is never saved: the conversation and the dog keep their own model selection, and the model picker still shows it. Cost and usage are booked to the account that actually ran each turn.

An account rests from the moment its engine reports the limit until the reset it reports. Claude Code says it in `api_error_params.rate_limit_info.resetsAt`, else in its words ("resets 3pm (America/Los_Angeles)"). Codex (codex-cli 0.154) fails the turn with `codexErrorInfo: "usageLimitExceeded"`; the reset comes from the account's full rate-limit window as its app-server last reported it (`account/rateLimits/updated`: the 5-hour or the weekly window, whichever resets last), else from its words ("try again at 3:05 PM"). When the error says nothing, later.dog reads the account's usage the way the Usage page does (only while the battery is on); failing that, it rests five hours. An Opus or Sonnet limit only stops that model family. A turn that starts after the limit was reported and then finishes on that account ends its rest early. Rests survive a restart in `~/.laterdog/account-battery.json`.

## When an account runs out mid-conversation

1. The limit is a failed turn (a limit message), never a reply: it is not shown as something the dog said, and not replayed to the model later. The message names the limit and when it resets, and offers **Continue on** a free account (**Add account** when none is free) and the switch; once the reset has passed, Retry.
2. With the switch on and another account ready, one status line replaces the limit message: "Switched to Claude account 2 — Claude account 1 is out of usage until 3:00 PM."
3. The same message runs again on that account. If the failed attempt had already used a tool, the next account is told instead to check what is already done and continue, not redo it.
4. If that account runs out too, the request moves on the same way. Each exhausted account rests until its reset, so work can pass through the whole list and through later reset windows without a lifetime retry ceiling.
5. When every account the conversation can use is out, it waits. The limit message says "Picks up where it stopped at 3:00 PM.", the soonest reset among those accounts. The wait is checked again every minute (a reset can move, and another conversation's turn can show an account works again), and at once when the switch is flipped.
6. Once one of them is free, "Picking up where it stopped, on Claude account 1." replaces the limit message and the request runs again there, as in step 3. If the dog is busy with other work at that moment, it tries again a minute later.
7. When a later turn runs on the conversation's own account again, the conversation gets one line: "Back on Claude account 1." A pickup on it says "Picking up where it stopped" instead.

Stop cancels the pickup. A mid-turn message stays in the conversation replay and does not cancel continuation. Queued messages remain durable and drain after the carried-on turn finishes; a message added during the recharge wait joins that queue. No queued turn steals the unfinished request's continuation.

The wait lives in memory: a restart forgets it, and the conversation does not pick up by itself; Retry on its limit message runs it again once the reset has passed. Rests survive a restart.

## What carries over

Another account is another Claude Code session, so the new account starts a fresh session with the conversation replayed into it — the same replay a conversation gets when its model is switched (`server/turn-context.ts`):

- carried over: the conversation's messages, by default the newest 24,000 bytes and at most 40 messages, plus the latest compaction summary (up to 6,000 bytes); the short records of earlier turns' work (digests); every file on this computer, which both accounts share;
- not carried over: tool outputs, the model's reasoning, images from earlier turns, and approvals granted "for this session" — the new session asks again.

## Group chats, routines and delegated work

- Group member turns carry on within the existing room operation, including waiting until an account recharges. The room keeps its original member, task and completion owner while the provider changes.
- Routines, automations, direct coordinated assignments and delegated work continue with the same run and result callbacks. An intermediate usage-limit attempt does not finish the routine or deliver a failure to a waiting teammate; the eventual outcome settles once.
- The server path is shared by local, self-hosted VPS and cloud-home subscription engines. A server can use only the eligible accounts connected to that server. A single-account setup with the switch explicitly enabled waits for that account's reset. Organization-managed hosted models remain outside the personal subscription battery.

## Verification and limits

`server/laterdog/account-battery.test.ts` (routing, rests, order, notices, when a waiting conversation can run again), `server/laterdog/limit-hold.test.ts` (the wait: one wake, the minute re-check, the re-check on the switch, a busy dog), `server/laterdog/carry-on.test.ts` (the pickup: which account, the notice in place of the limit message, the continuation after a tool, what stops it), `server/laterdog/continue-on-account.test.ts` (Continue on), `server/laterdog/usage-limit.test.ts` (Claude frames, Codex errors and windows, reset parsing), `server/drivers/claude.test.ts` (the driver's quota error), `src/components/LimitRow.test.ts`, `src/components/AccountSwitcher.test.ts` and `src/components/AccountsPanel.test.ts` (the limit message, the model picker's accounts and the Accounts list, each with the switch), `server/account-battery.e2e.test.ts` (a disposable server with two fake Claude accounts: switch, carry-over, continuation, no second account to move to, every account out then a pickup after the reset, back on account 1, booking per account, battery off, Continue on) and `server/account-battery-codex.e2e.test.ts` (the same switch, carry-over, rest and return for two fake ChatGPT accounts on the fake Codex app-server). Across engines, `server/account-battery.e2e.test.ts` runs two fake Claude accounts and a fake Codex account: every Claude account runs out, the work continues on Codex with the dog's chosen Backup model (read from the fake Codex's recorded `thread/start`), the chat line names both engines, the next message goes straight to Codex, and with the switch off nothing leaves Claude.

The frame shapes come from Claude Code 2.1.x as observed by a read-only investigation, reproduced by `server/testing/fake-claude-cli.ts` (`FAKE_CLAUDE_MODE=usage-limit`). The Codex error and window shapes come from codex-cli 0.154's own app-server schema (`codex app-server generate-ts`) and the wording in its binary; `server/testing/fake-codex-app-server.ts` (`FAKE_CODEX_MODE=usage-limit`) reproduces them. Fixture success does not qualify a live account: a real account reaching its limit, the usage-page fallback against a real login, a ChatGPT account added through Add account (which reaches Codex through its plan connection rather than Codex's own login), a real second account taking the conversation, and a conversation waiting through a real reset still need a live acceptance run.

**Live record, 2026-10-10 (Claude):** in a real conversation, the first of two Claude accounts hit its 5-hour limit. The conversation's next turn was recorded as "Switched to Claude 2", with the first account's reset time, and the dog carried on with its tool calls on the second account three seconds after the person's message. This is the app's own record of real use, read back from its message store; it covers the switch and the carry-over for Claude. Codex accounts, the wait through a real reset with every account out, and the return to the first account are still proven only with the fakes.


## Carry-on design, October 2026

Two ownership designs were considered: keep continuation decisions in the existing turn-completion owner, or introduce a separate scheduler that stores copies of routine, coordination and dispatch ownership. The completion owner was retained. `AccountBattery` owns one generation-checked continuation per thread; `LimitHold` owns only wake timers. A limit attempt releases its engine resources but leaves its routine, coordination, delegation and queued-send outcome unsettled. The succeeding attempt takes the continuation once and transfers the callbacks. Stop or turning continuation off settles cancellation visibly.

The reported mid-turn failure came from comparing the latest user-message id with the original request id, and from refusing continuation whenever a queued message existed. Both automatic switch and reset pickup now validate the original request's continued presence instead. Synthetic coordinated turns without a user-message row retain their original task prompt.

Rest windows and selected account routes survive restart. Held turn callbacks still live in memory; safely restoring routine outcomes, coordination promises and queue ownership across restart requires a durable continuation record shared with their existing journals. This change does not claim restart recovery. Organization-managed hosted models remain outside the personal subscription battery.
