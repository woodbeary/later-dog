# A dog's plan, kept per chat

The person wants one list per chat of what they asked a dog to do: what is
done, what is in progress and what has not started, kept across restarts.
Dogs keep it with later.dog's own `set_plan` tool, because the coding engines
run without a terminal offer no task-list tool of their own.

## How it works

- `set_plan` is declared in `server/drivers/agents-catalog.ts`, loads with the
  common tools (`server/laterdog/tool-loading.ts`) and skips the approval
  prompt like `react` (`server/agent-tool-policy.ts`). Input is the whole list,
  `items: [{ text, status }]` with status `pending`, `in_progress` or `done`, at
  most 20 items of at most 200 characters. Each call replaces the chat's list.
- The tool posts to `/api/internal/plan` (`server/routes/dog-plan.ts`). The
  home keeps plans in `dog-plans.json` under the data folder
  (`server/laterdog/dog-plan.ts`), written atomically, loaded at start and
  capped at the 500 most recently set chats.
- A plan belongs to the chat (thread) it was set in, and goes when that chat,
  its dog or its room is deleted (not when it is archived). A helper in its own
  chat keeps its own plan. A native helper inside the dog's engine shares the
  dog's chat, so the route asks which caller made the call: the engine sends
  its tool call id with every call, and every tool call in a helper's engine
  line (one with a parent call or a helper id) marks that id as a helper's. A
  helper's call is answered without being recorded. A call still unknown after
  1.5 seconds counts as the dog's, so a dog's own call is never refused.
- Item text loses control and format characters before it is checked; an item
  with nothing visible is refused. A corrupt `dog-plans.json` found at start is
  moved to `dog-plans.corrupt.json` instead of being written over.
- A room's thread keeps a plan too, but no app shows it yet, so the tool's
  answer there does not say the person sees it.
- An engine plan maps into the same store: a Codex `turn/plan/updated` from the
  main run (`server/laterdog/codex-native-activity.ts`) and a `TodoWrite` call
  from the main run (`server/drivers/claude.ts`), in case an engine version
  offers it again. An engine list that cannot be read is ignored; only an
  explicitly empty one clears the plan.
- Dogs are told to keep a plan only when later.dog's tools are mounted for the
  turn; a dog answering another dog at the depth limit is told to keep track in
  its reply instead.
- On the wire the plan is `plan: { items, updatedAt }` on the bot (its main
  chat) and on each entry of `bot.tasks` (`shared/wire.ts`). A change sends the
  `bot` frame on `/api/events`.
- The desktop (`src/components/PlanChecklist.tsx`) shows the list under the
  dog's working line while it works. When the dog is idle it folds to "N of M
  done" just under the "View work" row, on the same left edge, and opens to the
  list below it. Nothing shows without a plan.

## How it was proven

On isolated fixtures only, with the scripted fake engine:

- `pnpm exec vitest run server/dog-plan.e2e.test.ts` launches a fresh home with
  `launchVerificationServer`. A dog sets a plan through the real tool server;
  the tool list carries `set_plan` loaded up front; `/api/bots` and the `bot`
  frame carry the plan; after the server is stopped and started again on the
  same data folder the plan is still there; a second `set_plan` replaces it; a
  call the engine announces as a native helper's 0.4 seconds after the call
  arrives is refused, both for a line with a parent call and for one with only a
  helper id, and leaves the dog's plan as it was; another dog's plan stays in
  its own chat and goes when that chat is deleted.
- `server/laterdog/dog-plan.test.ts` and `server/routes/dog-plan.test.ts` cover
  validation, the cap, restart loading, engine mapping and the caller check;
  `server/drivers/agents-call.test.ts` covers the tool call and its call id.

## Seen with a real model

Once, on November 13, on the first coding engine with a real model, on an
isolated server with a test dog: the dog used `set_plan` without being asked,
recorded a "later" ask as pending, answered "checkpoint?" from the plan, and
made no plan for a quick question; the plan survived a server restart;
"thanks" became a tapback; a helper the dog started inside its engine was
refused with the "Not recorded" answer and the dog's plan did not change, so
the engine does send its tool call id on a live run.

## Not proven

- One run is not a rate: how often dogs keep the plan as told is unmeasured.
- The second coding engine with a real model. A Codex dog may keep both
  `update_plan` and `set_plan`; the last one wins. Codex native helpers calling
  `set_plan` are not told apart.
- If the engine's line naming a helper's call is more than 1.5 seconds behind
  the call, the call counts as the dog's.
- Group chats: rooms keep a plan that nobody sees yet.
- A real home, and the phone app, which does not read the plan yet.
