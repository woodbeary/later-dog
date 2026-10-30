# Typing suggestions

Grey words appear after a short pause in the message box. Tab adds them, Escape dismisses them, and any other key cancels a pending or shown suggestion.

## Two settings, and which is on by default

Settings has no Typing suggestions rows. Two config features decide it:

- **Typing suggestions**, on by default. The local fast path only: the person's own phrases, dog names and slash commands, matched on this computer. Nothing is sent anywhere.
- **Smarter suggestions**, off by default. Turns on the model path. The note beside it reads: "What you type and the last few messages go to Cloudflare to suggest the rest. Nothing is kept." The model path covers both the included service (plan and trial) and the person's own Cloudflare account, and ranking with the decision model, because that also sends what the person typed. The setting is `features.smarterSuggestions` and only the exact value `true` turns it on. A config written before this switch existed, or one that has never touched it, stays off. Turning Typing suggestions off turns everything off.

With Smarter suggestions off the app server answers `not-allowed` without calling anyone, the app never asks it, and the decision model is not asked to rank. The one exception is the "Check and save" button for the person's own Cloudflare account: it sends a fixed sample sentence, never anything typed, because the person pressed it.

## When it shows, and when it never does

It shows when the box has at least three characters, the caret is at the end, and nothing else owns the keyboard.

It never shows:

- when the box is empty or only spaces;
- while dictating (recording or retrying a voice note);
- in a password, one-time-code or card field, or inside a `data-secure-form` region;
- while a Secure Form card is open in the chat (the last 20 messages are checked);
- while the slash or mention picker is open, an approval is waiting, the composer is locked, or an input method is composing;
- when the caret is not at the end of the text;
- after the person turns Typing suggestions off. Learning phrases stops too;
- to anyone but the local fast path, until the person turns on Smarter suggestions.

Typed text that looks like a secret (API keys, tokens, `password: ...`, private keys, long hex or base64 strings, URLs with passwords) is never sent anywhere. `shared/typing-secrets.ts` holds the patterns. The app and the server both use them.

## What is sent

Only on the model path, which is off until the person turns on Smarter suggestions, and only these four things:

- the text typed so far (at most 1,500 characters);
- the dog's name;
- the last six text messages of this chat, 400 characters each, with attachments, code blocks, file paths, cards, secure forms and secret-looking strings removed;
- up to three of the person's own recent phrases, 120 characters each, as a sample of how they write.

No attachments, no file contents, no other chats. Nothing is stored on the server: the Worker keeps a per-day count of uses and nothing else, and logs no text. The app keeps a 64-entry, 60-second memory of answers so retyping the same text costs nothing.

## Three ways a suggestion is made

Only the first is on by default. The other two need Smarter suggestions.

1. **Fast path, this computer only.** Candidates come from the person's frequent phrases, dog names and slash commands. Phrases are learned from sent messages (sentences of 3 to 14 words, no links, code, tags or secrets), kept in the browser's local storage under `laterdog.typingPhrases.v1` (at most 300, most used first). The typed tail is matched against the start of each phrase, case-insensitively, and the longest match wins. A hit is shown after a 120 ms pause with no request at all.
2. **Ranking, optional, needs Smarter suggestions.** When two or more phrases tie for the longest match and the decision model is set up with the person's own Jev key, one `choice` question asks which is most likely. It has a 250 ms budget. When it does not answer in time, or is not set up, the most used phrase wins. The included relay only accepts room-routing questions, so ranking needs the person's own key.
3. **Model path, needs Smarter suggestions.** When no phrase fits, after a 400 ms pause, the app server asks a small model for about 20 tokens at temperature 0.2:
   - **Plan and trial users:** `POST /v1/complete` on later.dog's computers Worker, called with the installation's included-services key (the same trial key the free AI uses, sent as a bearer token). It runs `TYPING_AI_MODEL` (default `@cf/meta/llama-3.2-3b-instruct`) on Workers AI through the AI Gateway. It is available whenever the trial's included list has `ai`.
   - **Self-hosters:** an account id (`PATCH /api/config` with `typing.accountId`) and a Workers AI token. The token goes to the credential store (`cloudflareAiToken`, env `LATERDOG_CLOUDFLARE_AI_TOKEN`) like the other keys, and the app calls `api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>` itself. The model can be changed. The token is checked with one real call before it is saved and is never returned by `/api/config`.

If the person has saved their own Cloudflare account it is used instead of the included service. When the included service answers 404, 401, 403 or 5xx, the app stops asking it for five minutes.

## Numbers

Measured with fake backends in tests, so they show what this code adds, not what Workers AI takes.

Recorded 2026-10-14 on the integrator's Mac (Node 24, one test worker), 2,000 or 120 or 200 runs each after 10 warm-up runs.

| Path | What was measured | p50 | p95 | max | Budget |
| --- | --- | --- | --- | --- | --- |
| Fast path | `fastCandidates` plus `pickFast` over a full 300-phrase book, 2,000 runs, no request | 0.024 ms | 0.050 ms | 0.43 ms | under 100 ms |
| Model path through the app server, backend answers at once | the app's `POST /api/typing/complete` over loopback to a fake backend, 120 runs | 2.0 ms | 2.3 ms | 4.4 ms | server adds under 30 ms |
| Model path through the app server, backend takes 120 ms | the same, with the fake backend waiting 120 ms | 123.1 ms | 124.1 ms | 136.8 ms | under 300 ms |
| Worker around the model | `POST /v1/complete` through the Worker with an instant fake `AI` binding and in-memory fake Durable Objects, 200 runs | 0.11 ms | 0.18 ms | 0.61 ms | under 25 ms |

What these say: this code adds about 2 ms in the app server and a fraction of a millisecond in the Worker's own code, and the fast path is effectively free. What they do not say: how long Workers AI takes, how long the real Durable Object hop for the usage count takes (the test fakes it), or how long the network between the app and the Worker takes. For the 300 ms target the person's round trip plus the model has to fit in about 275 ms. Measure that after deploying (see below). The tests keep the budgets above from regressing.

The pause before the grey words show is separate: 120 ms for the fast path, 400 ms before asking the model.

## Limits worth knowing

- Nothing here has run against the live Worker or a real model. The first live number is the person's to measure after deploying: `pnpm --dir deploy/laterdog/computers deploy:worker`, then type in a chat.
- The 300 ms budget is for the whole model path. With the 400 ms pause the grey words appear about 400 ms plus the service time after the last key.
- The ghost text is drawn in the composer's mirror layer, so a suggestion that wraps onto a new line does not grow the box until it is accepted.
- Ranking uses the `typingSuggestions` job name with a cast in `server/laterdog/typing-rank.ts`, because the `DeciderJob` union on this branch does not have it yet. PR #41 widens that union. Once it lands, add the name there and drop the cast.
- Remote clients (a phone or a browser on another device) may call `/api/typing/complete` and `/api/typing/rank`. Only the owner may call `/api/typing/test`.

## Where the code is

- `deploy/laterdog/computers/src/complete.ts` and its route and handler: the Worker.
- `server/laterdog/typing-context.ts`, `typing-suggestions.ts`, `typing-rank.ts`, `typing-wiring.ts`, `server/routes/typing-suggestions.ts`: the app server.
- `src/lib/typing-suggestions.ts`, `use-typing-suggestion.ts`, `use-composer-suggestion.ts`, `src/components/TypingGhost.tsx`: the app.
- Tests sit beside each file. `server/laterdog/typing-suggestions.e2e.test.ts` runs the real server against a fake Worker.
