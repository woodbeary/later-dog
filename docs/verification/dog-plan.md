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
- A plan belongs to the chat (thread) it was set in. A helper in its own chat
  keeps its own plan. A native helper inside the dog's engine shares the dog's
  chat, so the route asks which caller made the call: the engine sends its tool
  call id with every call, and the engine stream says whether that call came
  from a helper. A helper's call is answered without being recorded.
- An engine plan maps into the same store: a Codex `turn/plan/updated` from the
  main run (`server/laterdog/codex-native-activity.ts`) and a `TodoWrite` call
  from the main run (`server/drivers/claude.ts`), in case an engine version
  offers it again.
- On the wire the plan is `plan: { items, updatedAt }` on the bot (its main
  chat) and on each entry of `bot.tasks` (`shared/wire.ts`). A change sends the
  `bot` frame on `/api/events`.
- The desktop (`src/components/PlanChecklist.tsx`) shows the list under the
  dog's working line while it works, and folds it to "N of M done" when the
  dog is idle. Nothing shows without a plan.

## How it was proven

On isolated fixtures only, with the scripted fake engine:

- `pnpm exec vitest run server/dog-plan.e2e.test.ts` launches a fresh home with
  `launchVerificationServer`. A dog sets a plan through the real tool server;
  the tool list carries `set_plan` loaded up front; `/api/bots` and the `bot`
  frame carry the plan; after the server is stopped and started again on the
  same data folder the plan is still there; a second `set_plan` replaces it; a
  call announced by the engine as a native helper's is refused and leaves the
  dog's plan as it was; another dog's plan stays in its own chat.
- `server/laterdog/dog-plan.test.ts` and `server/routes/dog-plan.test.ts` cover
  validation, the cap, restart loading, engine mapping and the caller check;
  `server/drivers/agents-call.test.ts` covers the tool call and its call id.

## Not proven

- No real model has been run with `set_plan`: whether dogs keep the plan as
  told, and how often, is unmeasured.
- The engine's tool call id in each call was read from the installed engine
  2.1.316, not observed on a live run. If an engine sends no id, a helper's
  call counts as the dog's. If the stream is more than 1.5 seconds behind the
  call, the same happens.
- A Codex dog may keep both `update_plan` and `set_plan`; the last one wins.
  Codex native helpers calling `set_plan` are not told apart.
- Group chats keep one plan for the room's thread, and no client shows it yet.
- The phone app does not read the plan yet.
