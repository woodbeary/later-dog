# Token battery

Several Claude or ChatGPT (Codex) subscription accounts, used one after another. You sign in to each account in Settings → AI → Engines (Add Claude account, Add ChatGPT account), then put each engine's accounts in a "next up" order with a favourite first. When the account a conversation runs on reaches its usage limit, later.dog continues the conversation on the next account of the same engine in that order. Once the favourite's limit resets, conversations go back to it. A Claude conversation stays on Claude accounts and a Codex one on Codex accounts: moving to the other engine would change the model, which stays your choice.

Nothing changes until you switch the battery on. Rotating several personal subscriptions is your own choice under each provider's terms; later.dog does not decide for you whether that is allowed for your accounts.

## Turning it on

Settings → AI → Engines → **Token battery**, below the Add account buttons:

- the switch turns the rotation on or off;
- one list per engine (Claude, then Codex) holds every subscription account of that engine on this computer, in the order turns use them. The star marks the favourite (the first). The arrows move an account up or down; the star on another row makes it the favourite;
- each row says **Ready**, **Resting until** a time, or **Not signed in**. A row signed in to the same login as an earlier one says so: two configuration folders on one Anthropic login share one limit, and rest together.

Accounts added later join the end of the order until you save a new one. Removing an account takes it out of the order.

Saved in `config.json`:

```json
{ "accountBattery": { "enabled": true, "order": { "claudeAgent": ["claude", "claude-1f2e…"], "codex": ["chatgpt", "chatgpt-9a7c…"] } } }
```

Only Claude and ChatGPT accounts on a personal subscription login are in the battery. Claude on the API key from Settings → API keys, an account signed in with an API key, a router or other custom endpoint, an engine your organization manages, and an engine its policy refuses are never used by it.

## Which account a turn runs on

Each turn runs on the first account in the order that is enabled, not known to be signed out, not resting, and offers the turn's model (a custom model id only one account lists stays on that account). If every account rests, the turn runs on the account the conversation names and reports the limit again.

The choice is never saved: the conversation and the bot keep their own model selection, and the Model picker still shows it. Cost and usage are booked to the account that actually ran each turn.

An account rests from the moment its engine reports the limit until the reset it reports. Claude Code says it in `api_error_params.rate_limit_info.resetsAt`, else in its words ("resets 3pm (America/Los_Angeles)"). Codex (codex-cli 0.154) fails the turn with `codexErrorInfo: "usageLimitExceeded"`; the reset comes from the account's full rate-limit window as its app-server last reported it (`account/rateLimits/updated`: the 5-hour or the weekly window, whichever resets last), else from its words ("try again at 3:05 PM"). When the error says nothing, later.dog reads the account's usage the way the Usage page does (only while the battery is on); failing that, it rests five hours. An Opus or Sonnet limit only stops that model family. A turn that starts after the limit was reported and then finishes on that account ends its rest early. Rests survive a restart in `~/.laterdog/account-battery.json`.

## When an account runs out mid-conversation

1. The limit is a failed turn (an error row), never a reply: it is not shown as something the bot said, and not replayed to the model later.
2. If another account is ready, one status line follows: "Switched to Claude account 2 — account 1 is out of usage until 3:00 PM."
3. The same message runs again on that account. If the failed attempt had already used a tool, the next account is told instead to check what is already done and continue, not redo it.
4. That second run happens once. If the next account is out of usage too, its limit is the answer, and Retry stays on that row.
5. When the original account's reset has passed and a turn is routed to it again, the conversation gets one line: "Back on account 1."

Stop, a newer message, or words queued while the turn ran win over the second run.

## What carries over

Another account is another Claude Code session, so the new account starts a fresh session with the conversation replayed into it — the same replay a conversation gets when its model is switched (`server/turn-context.ts`):

- carried over: the conversation's messages, by default the newest 24,000 bytes and at most 40 messages, plus the latest compaction summary (up to 6,000 bytes); the short records of earlier turns' work (digests); every file on this computer, which both accounts share;
- not carried over: tool outputs, the model's reasoning, images from earlier turns, and approvals granted "for this session" — the new session asks again.

## Group chats, routines and delegated work

- Group chats pick the account the same way for each member's turn. A group turn that runs out is not run again; the room's next turn goes to the next account.
- Routines: a run that runs out fails as it always did; the routine's next run uses the next account.
- Work another bot delegated, coordinated assignments and webhook turns are not run twice either; the failure reports back as usual, and their next turn uses the next account.

## Verification and limits

`server/laterdog/account-battery.test.ts` (routing, rests, order, notices), `server/laterdog/usage-limit.test.ts` (Claude frames, Codex errors and windows, reset parsing), `server/drivers/claude.test.ts` (the driver's quota error), `src/components/TokenBatterySettings.test.ts` (the Settings card, both engines), `server/account-battery.e2e.test.ts` (a disposable server with two fake Claude accounts: switch, carry-over, continuation, one attempt only, back on account 1, booking per account, battery off) and `server/account-battery-codex.e2e.test.ts` (the same switch, carry-over, rest and return for two fake ChatGPT accounts on the fake Codex app-server).

The frame shapes come from Claude Code 2.1.x as observed by a read-only investigation, reproduced by `server/testing/fake-claude-cli.ts` (`FAKE_CLAUDE_MODE=usage-limit`). The Codex error and window shapes come from codex-cli 0.154's own app-server schema (`codex app-server generate-ts`) and the wording in its binary; `server/testing/fake-codex-app-server.ts` (`FAKE_CODEX_MODE=usage-limit`) reproduces them. Fixture success does not qualify a live account: a real account reaching its limit, the usage-page fallback against a real login, a ChatGPT account added through Add ChatGPT account (which reaches Codex through its plan connection rather than Codex's own login) and a real second account taking the conversation still need a live acceptance run.
