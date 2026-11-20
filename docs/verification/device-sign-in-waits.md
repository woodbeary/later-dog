# A device sign-in waits for the person, November 20

A dog that shows a device-code card (`request_device_approval`) ends its turn and waits.
If the code runs out before the person uses it, the dog is not woken: the card says
Code expired and offers Get a new code, the chat shows the dog waiting on the person, and
the person gets one notice. Tapping Get a new code wakes the dog once to start a fresh
sign-in. A dog that asks again while the last code expired unused, or that has already
shown two codes nobody used, is refused and told to end its turn and say what it waits for.

## Recipe

Start a fixture whose fake engine asks for a device sign-in on every turn, with a code that
lasts six seconds:

```sh
FAKE_CLAUDE_MODE=device-approval FAKE_CLAUDE_DEVICE_HOLD_MS=15000 FAKE_CLAUDE_DEVICE_EXPIRES_MS=6000 \
  node --experimental-strip-types scripts/control-laterdog.ts launch
```

Send the starter dog one message, then read `GET /api/bots` and
`GET /api/threads/<thread>/messages` once a second for a minute:

- one card appears, turns `expired` with `endedBy: "expiry"` and `renew: "offered"`;
- no second turn starts and no second card appears;
- the dog shows `busy: false` and `work: { kind: "needs-you", what: "Approve the Fixture CLI sign-in" }`.

Then `POST /api/bots/<bot>/device-approvals/<card>/renew` with `{ threadId }`: the card
shows `renew: "asked"`, exactly one new turn starts and shows one new card. A second
renew on the same card starts nothing.

Before this change the same fixture started a new turn and a new card every time a code
expired, with no one in the chat.

## Limits

The fake engine always asks again when woken; a real engine decides for itself, so the
refusal text it gets is what holds it. Whether a dog on a real engine obeys
that text was not checked on a live home.
