# One model's limit and the real account limit, November 14

On November 14, account daniel rested until Monday 9:00 while its own reading showed 69% of the week and 0% of the session used, and the phone said "0% left · Week used up".

## Cause

The installed Claude engine reports a model's own weekly allowance as a refusal. Its rate-limit type is `seven_day_overage_included`, which the engine calls the Fable limit, and the words are "You've reached your Fable limit."; the reset is the weekly reset. The battery treated only `opus` and `sonnet` as one model's limit. Any other kind rested every model on the account until the reset. Every report also asked whether the account rested without naming a model, so even an Opus limit showed as the whole account used up. That covers the phone's `accountBattery.resting`, `restingUntil` in `GET /api/plan-usage`, and the dogs' `account_usage`. No reading could end the rest, because the usage reply's per-model weekly windows (`limits[]`) were never read.

## What changed

- A rest can carry `model`. It is stored apart from the account's own rest, keyed `<account>#<model family>`, and saved rests from before this change are split on load. Only dogs on that model move; other models and other dogs keep using the account. A finished turn on another model leaves it in place. Revival checks the model a chat runs on.
- The model comes from the limit kind (`opus`, `sonnet`, `haiku`, `fable`) or, for `seven_day_overage_included`, from the model the turn ran on, read from the turn's execution record.
- A rest ends no later than the reset the provider's reading gives for the window it is based on. A fresher reading with room in every window it is based on, and different from the reading saved at refusal, clears it. An unchanged reading keeps it, so a refused account is not tried again and again.
- `parseClaudeUsage` reads `limits[]` entries of kind `weekly_scoped` into `models`. A model window at 100% rests that model from the reading alone.
- `GET /api/plan-usage` rows carry `limitsHit`. `restingUntil` now means the whole account rests. The contract is in pull request 199.
- Instances with `access: "api"` or `requireApiKey`, such as "Claude (API key)", have no plan usage row.
- `account_usage` and `dog_accounts` say which limit is hit, in the same labels.

## Checks (Linux cloud computer, fixtures only)

- `server/laterdog/account-real-limit.test.ts` reproduces daniel's case through `claudeUsageLimit`, `AccountBattery`, `withRestingUntil` and `accountUsageText`. It fails on `main` 088df2f (2 of 2 failed) and passes on this branch.
- `server/account-model-limit.e2e.test.ts` runs the real server with the fake engine. Account daniel refuses only Fable, with the engine's frame. On `main` it fails eight ways: the whole account rests, `restingUntil` is set, `limitsHit` is missing, the API-key row is listed, and the Sonnet dog is moved off daniel. On this branch it passes.
- `server/laterdog/account-limits.test.ts`: 16 tests. Eight deliberate breaks of the new behaviour were each caught by at least one test.

Not proven: no real account, provider or phone was used. The saved kind of daniel's rest on the owner's home was not read.
