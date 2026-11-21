# A turn stuck on the same answer ends, November 20

A dog that makes the same tool call (same tool, same arguments) and gets the same answer ten
times in one turn is stopped. The chat says what it ran and that it is waiting for that answer
to change, so the person can tell it what to do next. Other calls in between, such as a wait,
do not reset the count; a different answer does. The warning lines at 5, 10 and 20 repeats of
a call stay as they were.

A call whose answer changes is never stopped by this rule, so polling a build that moves on is
left alone. A call with no answer text is not counted.

## Recipe

```sh
FAKE_CLAUDE_MODE=repeat-loop FAKE_CLAUDE_REPEAT_TIMES=30 FAKE_CLAUDE_REPEAT_ANSWER=same \
  node --experimental-strip-types scripts/control-laterdog.ts launch
```

Send the starter dog one message, then read `GET /api/threads/<thread>/messages`:

- ten `fixture-cli auth status` calls, then one failed-turn line that names the call and says
  it is waiting for the answer to change;
- no `Finished checking` reply, and the dog shows `busy: false`.

With `FAKE_CLAUDE_REPEAT_ANSWER=changing` the same fixture runs all thirty calls and replies
`Finished checking fixture-cli auth status 30 times.` with no stop line.

`pnpm exec vitest run server/same-answer-loop.e2e.test.ts` runs both and writes
`.laterdog-evidence/same-answer-loop/`.

## Limits

- Only direct chats are stopped; a room turn still gets only the warning lines.
- A loop whose answer changes every time (a fresh code on every try) is not caught by this rule.
  The device sign-in card has its own hold for that case.
- Polling that gets the identical answer ten times in a turn is stopped, even if the thing it
  polls would have moved on later. Checked only on the fake engine, not on a live home.
