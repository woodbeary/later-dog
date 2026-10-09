# Token battery

Several Claude or ChatGPT (Codex) subscription accounts, used one after another. You add each account in Settings → General → Accounts (Add account) and switch on **Keep going when an account runs out**. When the account a conversation runs on reaches its usage limit, later.dog continues the conversation on your next account of the same engine, and the conversation goes back to its own account once that limit resets. When every account it can use is out, it waits and picks up where it stopped as soon as the first limit resets, so you can walk away. A Claude conversation stays on Claude accounts and a Codex one on Codex accounts: moving to the other engine would change the model, which stays your choice.

Nothing changes until you switch it on. Rotating several personal subscriptions is your own choice under each provider's terms; later.dog does not decide for you whether that is allowed for your accounts.

## Turning it on

**Keep going when an account runs out** is one setting, switched from any of three places:

- Settings → General → Accounts, below Add account;
- the model picker, below its list of accounts and their usage;
- the message a conversation gets when its account runs out.

The order is the Accounts list: Claude accounts, then ChatGPT accounts, each engine's in the order saved when the switch was last flipped, then any added since. The list has no way to reorder accounts. Removing an account takes it out of the order. Each account shows its usage, **Resting until** a time, or **Not signed in**. Two configuration folders signed in to one Anthropic login share one limit, and rest together.

Saved in `config.json`:

```json
{ "accountBattery": { "enabled": true, "order": { "claudeAgent": ["claude", "claude-1f2e…"], "codex": ["chatgpt", "chatgpt-9a7c…"] } } }
```

Only Claude and ChatGPT accounts on a personal subscription login are in the battery. Claude through an API key, an account signed in with an API key, a router or other custom endpoint, an engine your organization manages, and an engine its policy refuses are never used by it.

## Which account a turn runs on

Each turn runs on the first of these that can take it:

1. the account picked with **Continue on** in the limit message, while the account that ran out still rests and until another account is picked in the model picker;
2. the account the conversation names (its model selection), when it is enabled, not known to be signed out and not resting;
3. with the switch on, the first account in the order that is enabled, not known to be signed out, not resting, and offers the turn's model (a custom model id only one account lists stays on that account).

If every account rests, the turn runs on the account the conversation names and reports the limit again.

The choice is never saved: the conversation and the dog keep their own model selection, and the model picker still shows it. Cost and usage are booked to the account that actually ran each turn.

An account rests from the moment its engine reports the limit until the reset it reports. Claude Code says it in `api_error_params.rate_limit_info.resetsAt`, else in its words ("resets 3pm (America/Los_Angeles)"). Codex (codex-cli 0.154) fails the turn with `codexErrorInfo: "usageLimitExceeded"`; the reset comes from the account's full rate-limit window as its app-server last reported it (`account/rateLimits/updated`: the 5-hour or the weekly window, whichever resets last), else from its words ("try again at 3:05 PM"). When the error says nothing, later.dog reads the account's usage the way the Usage page does (only while the battery is on); failing that, it rests five hours. An Opus or Sonnet limit only stops that model family. A turn that starts after the limit was reported and then finishes on that account ends its rest early. Rests survive a restart in `~/.laterdog/account-battery.json`.

## When an account runs out mid-conversation

1. The limit is a failed turn (a limit message), never a reply: it is not shown as something the dog said, and not replayed to the model later. The message names the limit and when it resets, and offers **Continue on** a free account (**Add account** when none is free) and the switch; once the reset has passed, Retry.
2. With the switch on and another account ready, one status line replaces the limit message: "Switched to Claude account 2 — Claude account 1 is out of usage until 3:00 PM."
3. The same message runs again on that account. If the failed attempt had already used a tool, the next account is told instead to check what is already done and continue, not redo it.
4. If that account runs out too, the request moves on the same way. A request runs again at most eight times in all, counting the pickups below; after that its limit is the answer, and Retry runs it again once the reset has passed.
5. When every account the conversation can use is out, it waits. The limit message says "Picks up where it stopped at 3:00 PM.", the soonest reset among those accounts. The wait is checked again every minute (a reset can move, and another conversation's turn can show an account works again), and at once when the switch is flipped.
6. Once one of them is free, "Picking up where it stopped, on Claude account 1." replaces the limit message and the request runs again there, as in step 3. If the dog is busy with other work at that moment, it tries again a minute later.
7. When a later turn runs on the conversation's own account again, the conversation gets one line: "Back on Claude account 1." A pickup on it says "Picking up where it stopped" instead.

Stop, a newer message, or words queued while the turn ran win over the run on the next account and over the pickup. Words queued while the turn ran wait with the conversation ("1 message(s) waiting. They'll send once this dog can carry on.") and are sent once it can run again, switch on or off; with the switch off, nothing else picks up by itself. A message sent while the conversation waits is sent at once, after any that were waiting.

The wait lives in memory: a restart forgets it, and the conversation does not pick up by itself; Retry on its limit message runs it again once the reset has passed. Rests survive a restart.

## What carries over

Another account is another Claude Code session, so the new account starts a fresh session with the conversation replayed into it — the same replay a conversation gets when its model is switched (`server/turn-context.ts`):

- carried over: the conversation's messages, by default the newest 24,000 bytes and at most 40 messages, plus the latest compaction summary (up to 6,000 bytes); the short records of earlier turns' work (digests); every file on this computer, which both accounts share;
- not carried over: tool outputs, the model's reasoning, images from earlier turns, and approvals granted "for this session" — the new session asks again.

## Group chats, routines and delegated work

- Group chats pick the account the same way for each member's turn. A group turn that runs out is not run again or picked up; the room's next turn goes to the next account.
- Routines: a run that runs out fails as it always did; the routine's next run uses the next account.
- Work another dog delegated, coordinated assignments and webhook turns are not run again or picked up either; the failure reports back as usual, and their next turn uses the next account.

## Verification and limits

`server/laterdog/account-battery.test.ts` (routing, rests, order, notices, when a waiting conversation can run again), `server/laterdog/limit-hold.test.ts` (the wait: one wake, the minute re-check, the re-check on the switch, a busy dog), `server/laterdog/carry-on.test.ts` (the pickup: which account, the notice in place of the limit message, the continuation after a tool, what stops it), `server/laterdog/continue-on-account.test.ts` (Continue on), `server/laterdog/usage-limit.test.ts` (Claude frames, Codex errors and windows, reset parsing), `server/drivers/claude.test.ts` (the driver's quota error), `src/components/LimitRow.test.ts`, `src/components/AccountSwitcher.test.ts` and `src/components/AccountsPanel.test.ts` (the limit message, the model picker's accounts and the Accounts list, each with the switch), `server/account-battery.e2e.test.ts` (a disposable server with two fake Claude accounts: switch, carry-over, continuation, no second account to move to, every account out then a pickup after the reset, back on account 1, booking per account, battery off, Continue on) and `server/account-battery-codex.e2e.test.ts` (the same switch, carry-over, rest and return for two fake ChatGPT accounts on the fake Codex app-server).

The frame shapes come from Claude Code 2.1.x as observed by a read-only investigation, reproduced by `server/testing/fake-claude-cli.ts` (`FAKE_CLAUDE_MODE=usage-limit`). The Codex error and window shapes come from codex-cli 0.154's own app-server schema (`codex app-server generate-ts`) and the wording in its binary; `server/testing/fake-codex-app-server.ts` (`FAKE_CODEX_MODE=usage-limit`) reproduces them. Fixture success does not qualify a live account: a real account reaching its limit, the usage-page fallback against a real login, a ChatGPT account added through Add account (which reaches Codex through its plan connection rather than Codex's own login), a real second account taking the conversation, and a conversation waiting through a real reset still need a live acceptance run.
