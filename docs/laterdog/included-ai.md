# The free AI in the trial

During a free trial (and on the later.dog Cloud plan), a dog can chat on later.dog's own models with no account:

| In the app | Model id | Provider | Reached through |
| --- | --- | --- | --- |
| **Claude**, Claude Sonnet 5 (the default for a new dog) | `claude-sonnet-5` | Anthropic | Cloudflare AI Gateway, `anthropic` provider |
| **Grok**, Grok 4.7 | `grok-4.7` | xAI | Cloudflare AI Gateway, `grok` provider |
| **Grok**, Grok 4.6 | `grok-4.6` | xAI | Cloudflare AI Gateway, `grok` provider |
| not offered as a choice: the fallback | `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 on Workers AI | Cloudflare AI Gateway |

The app sends every free chat to `POST /v1/ai/chat/completions` on the computers Worker (`cloud.later.dog`), with the
installation's trial or plan key and the model id it wants. The Worker (`deploy/laterdog/computers/src/ai.ts` and
`src/claude.ts`) picks the provider by that id, turns an OpenAI-style chat into Anthropic's Messages API and back for
Claude, and logs no prompts in the gateway (`cf-aig-collect-log: false`).

## Which model answers

- A Claude id goes to Claude, then Kimi K2.6, then Grok 4.7.
- A Grok id goes to that Grok, then Kimi K2.6. An id that is not Grok 4.7 or 4.6 (an older app asking for `grok-4.3`)
  gets `TRIAL_GROK_MODEL`.
- A Kimi id, or no id, goes to Kimi K2.6 first, then Grok (`TRIAL_AI_FIRST` changes the order for requests without an
  id).
- A provider is skipped when its key is not set, when the installation or everyone has used its daily allowance, or
  when it answers with an error. The next one answers instead, so a chat keeps going. **Without `ANTHROPIC_API_KEY`,
  a dog on Claude Sonnet 5 is answered by Kimi K2.6.** The app still shows Claude Sonnet 5; the answer's `model` field
  says which model replied.
- Claude replies stream with their tool calls and signed thinking. The thinking goes back to the app as
  `reasoning_details` and returns to Claude on the next step of the same turn. It is never sent to Grok or Kimi.
- Claude runs at effort `medium` with adaptive thinking and prompt caching on. Sampling settings (`temperature`,
  `top_p`, `seed`) are dropped, because Claude Sonnet 5 refuses them.
- Titles, memory notes and summaries of long chats use Kimi K2.6 (`INCLUDED_BACKGROUND_MODEL` in
  `server/laterdog/included-ai.ts`), so they never spend the Claude or Grok allowance.
- The app declares a 256k context window for all three, the size Kimi K2.6 can take, so a long chat can always move
  to the fallback.

When the app updates, dogs, threads, fallbacks and the new-dog default that were on the retired free models move once
at start: Kimi K2.6 to Claude Sonnet 5, Grok 4.3 to Grok 4.7 (`server/laterdog/included-ai-moves.ts`).

## Daily allowances

Every answer counts against the installation's general allowance (1.5 million tokens a day, 100 million for everyone;
the person sees "You've used today's free messages" when it runs out). Claude and Grok also have their own
allowances, set by vars in `wrangler.jsonc`. A cached prompt token counts at its share of the price: a tenth for
Claude, a quarter for Grok.

| Var | Default | Means |
| --- | --- | --- |
| `TRIAL_CLAUDE_TOKENS_PER_DAY` | `200000` | Claude tokens one installation can use a day. `0` switches Claude off. |
| `TRIAL_CLAUDE_TOKENS_TOTAL_PER_DAY` | `10000000` | Claude tokens everyone together can use a day. |
| `TRIAL_GROK_TOKENS_PER_DAY` | `300000` | Grok tokens one installation can use a day. `0` switches Grok off. |
| `TRIAL_GROK_TOKENS_TOTAL_PER_DAY` | `15000000` | Grok tokens everyone together can use a day. |
| `TRIAL_CLAUDE_MODEL` | `claude-sonnet-5` | The Claude model for a Claude id the Worker does not offer. `claude-sonnet-5-5` is also accepted when the app asks for it. |
| `TRIAL_GROK_MODEL` | `grok-4.7` | The Grok model for a Grok id the Worker does not offer. |

Days are UTC. After an installation's Claude or Grok allowance is used up, its chats carry on with Kimi K2.6 until the
general allowance runs out.

## What a capped installation costs a day

List prices on 2026-10-15: Claude Sonnet 5 $2 per million input tokens, $2.50 for a cache write, $0.20 for a cache
read, $10 per million output tokens (Anthropic). Grok 4.7 and 4.6 $2 per million input tokens, $0.50 cached, $6 per
million output tokens, twice that for a prompt over 200k tokens (xAI). A counted token therefore costs between the
input and the output price.

| Model | Allowance | Worst case (all output) | Typical (about 85% prompt, 15% reply) |
| --- | --- | --- | --- |
| Claude Sonnet 5, one installation | 200,000 | $2.00 a day | about $0.70 a day |
| Claude Sonnet 5, everyone | 10,000,000 | $100 a day | about $35 a day |
| Grok 4.7 or 4.6, one installation | 300,000 | $1.80 a day | about $0.80 a day |
| Grok 4.7 or 4.6, everyone | 15,000,000 | $90 a day | about $40 a day |

Kimi K2.6 runs on Workers AI and is paid from the Cloudflare account. The typical column is an estimate from the mix
above, not a measurement.

## Setting it up

Claude needs an Anthropic API key as a Worker secret. Use a key from an Anthropic workspace with a monthly spend limit,
and paste it when wrangler asks (it is never printed):

```sh
cd deploy/laterdog/computers && pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

Grok uses the existing `XAI_API_KEY` secret. Then deploy the Worker (no new container image is needed):

```sh
cd deploy/laterdog/computers && pnpm run deploy:worker
```

Until the secret is set, the deployed Worker answers Claude requests with Kimi K2.6. To check which keys are set,
`pnpm exec wrangler secret list` shows names only.

Not wired: AI Gateway's stored keys or Unified Billing for Anthropic. The Worker always sends the key itself.

## Checks

- `deploy/laterdog/computers/test/included-claude.test.ts`: routing by model, the Messages API request (system,
  images, tools, tool results, thinking, effort, caching, no sampling settings), the stream and answer translation,
  the Kimi fallback without a key and after an error, the Claude and Grok allowances and their kill switch.
- `deploy/laterdog/computers/test/included-ai.test.ts`: Grok by model id, Kimi, stream handling.
- `server/laterdog/included-ai.test.ts`: the app's catalogs, the move off retired models, the new-dog default.
- `src/components/ModelPicker.free-twin.test.ts`: one Claude button in the model picker, before and after the trial.

All of these run against fakes. The Anthropic route through the AI Gateway has not been called live; check it with the
owner-grant recipe after the deploy before relying on it.
