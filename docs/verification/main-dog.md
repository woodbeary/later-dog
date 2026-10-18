# The main dog

Every workspace has exactly one main dog: the dog the person talks to first.
The server keeps it as one pointer (`shared/main-dog.ts`). With no saved choice
it is the visible saved Chief of Staff from older builds (an unsectioned one
first, then by sidebar order), else the oldest visible dog, else the oldest dog.
The wire still carries it as `chiefOfStaff: true` on exactly one dog, so the
desktop and the phone agree without their own rule.

- `PATCH /api/main-dog` with `{ "botId": "…" }` moves it. `PATCH /api/bots/:id`
  with `{ "chiefOfStaff": true }` does the same; `false` on the main dog is
  refused with 409.
- `DELETE /api/bots/:id` on the main dog is refused with 409. Hiding it is
  allowed and it stays the main dog.
- Only the main dog gets one routing sentence in its prompt, and only when
  there is another dog to route to. It has no extra tools or authority.

## Check it

```sh
pnpm exec vitest run shared/main-dog.test.ts server/store.test.ts -t "main dog"
pnpm exec vitest run server/index.test.ts -t "main dog"
```

On an isolated fixture (`node --experimental-strip-types scripts/control-laterdog.ts launch`),
the starter dog is the main dog: deleting it returns 409, hiding it returns
200 and it still answers a message, and after `PATCH /api/main-dog` to another
dog the old one can be deleted.
