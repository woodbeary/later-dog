# Tasks

A task is a separate conversation a dog starts for one piece of work. It runs
on its own, next to the dog's main conversation, and the person follows it in
the Tasks list until they mark it done.

## How a task starts

When the person asks for several separate pieces of work at once, the dog calls
`start_tasks` with one to five tasks, each a short title and the whole
instruction. For each one, later.dog:

- opens a conversation of that dog with `openedBy` set to the dog itself,
  `kind: "work"`, and the conversation it was started from;
- gives it the same person as the conversation it came from, so the owner's
  Mac and iPhone tools work in it as they do there;
- starts a turn with the instruction as the opening message.

The dog's tools, model and approval level apply in the task as anywhere else.
A dog runs at most `threads.maxConcurrentPerBot` conversations at once (10 by
default); a task over that limit is reported back and the dog does the work
itself. A task cannot start more tasks. Replies stay in the task; the main
conversation only says what was started.

Code: `server/laterdog/dog-tasks.ts`, `server/routes/dog-tasks.ts`, the tool in
`server/drivers/agents-catalog.ts`. End-to-end check:
`server/dog-tasks.e2e.test.ts`.

## How tasks show

Both apps list every conversation a dog opened (`openedBy` set), across all
dogs, apart from each dog's main conversation:

| State | Shown when |
| --- | --- |
| Needs you | the task waits on the person (`activity: "waiting-on-you"`) |
| Working | a turn is running |
| Ready for review | it finished with a reply the person hasn't read |
| Open | none of the above |
| Done | the person marked it done (`archivedAt`), or a dog closed it (`closedBy`); kept for a week |

The list sorts by state or by dog. Opening a task shows its own conversation,
where the person can reply, answer its cards and approve its steps. Mark as
done sets `archivedAt` through `PATCH /api/bots/:id/tasks/:threadId`; Reopen
clears it.

On the desktop, Tasks appears in the sidebar once a dog has started one, with
the number of tasks that need the person or are ready for review
(`src/components/TasksPage.tsx`, `src/components/SidebarTasksRow.tsx`,
`src/lib/tasks.ts`, `src/state/task-view.ts`). An open task keeps its own
messages, so the dog's main conversation and the task never mix.
