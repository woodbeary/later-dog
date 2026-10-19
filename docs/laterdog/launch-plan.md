# Launch plan

What has to be true before later.dog is announced widely, written 2026-10-19. The detailed lane map for the app itself
is [finalize-plan-2026-10-18.md](finalize-plan-2026-10-18.md); this page covers the launch around it.

## Goals

1. **Sign in and go.** Mac and iPhone, one email code, one workspace in the Cloud home.
2. **Strangers cannot run up the bill.** Free and trial usage has caps; the person's own sign-ins have none from us.
3. **Credits last.** Provider credits and the Cloudflare grant are spent on purpose, with a kill switch per provider.
4. **The website explains it in 3 to 10 seconds**, with real screens of the app and real motion.
5. **The repository reads like today's product**: a short README, docs for features that exist, one clean history.

## Workstreams

| Slice | What | Where | Proven by |
| --- | --- | --- | --- |
| Free-key limits | Reserve free usage before each model call, cap request and prompt sizes, Grok by name only on home and plan keys, a human check to start a trial | `deploy/laterdog/computers` | Worker tests with a fake upstream |
| Sign-up guards | Codes never wake a home, a shared cap for new addresses, no throwaway domains, Turnstile when its secret is set, unused home slots released | `cloudflare/control-plane` | control-plane tests on local D1 |
| Home guard | A sleeping home starts only for a credential its Worker can check, and sleeps 30 minutes after last use | `deploy/laterdog/home` | home Worker tests with fake containers |
| Voice credits | ElevenLabs only when switched on and inside a daily budget, Aura-2 otherwise; spoken audio cached; dictation through AI Gateway | `deploy/laterdog/computers` | cache and budget tests |
| Claude first | A small Claude model in front of the included AI, only if it matches Kimi on recorded tool turns | `deploy/laterdog/computers` | a fixture eval |
| Edge rules | Zone rate limits on sign-in and trial routes, managed rules, zone hygiene | Cloudflare dashboard or `cf` | a burst test after they are applied |
| Gateway | A dedicated AI Gateway with provider keys stored there and a daily spend limit per provider | Cloudflare dashboard | a tiny limit on a test gateway falls back cleanly |
| Phone delivery | Over-the-air updates that cannot crash the current TestFlight build, a local verify script | `later-dog-phone` | the verify script, a fingerprint compare, Expo Go on fixtures |
| Website | Real screens and short clips, one focal point per section, the architecture picture, fixed links | `later-dog-site` | a preview at 390 px and 1440 px |
| Repository | This README and docs, trimmed GitHub workflows, archived and linearized history | this repository | the docs tests and tree-hash equality |

## Order

1. Archive every branch and pull request ref before anything is rewritten.
2. Website link fixes, then the edge rules and the gateway, which need the person's clicks.
3. The Worker slices above, each landed on the integration branch with its own tests.
4. Deploys, one at a time, each after a dry run the person approves.
5. The phone update, after its guard and verify script pass.
6. The website redesign, starting with one sample section the person judges.
7. History rebuilt into one clean line, merged by the person.

## Decided by the person

- The ElevenLabs balance and whether it resets monthly, which sets the daily voice budget.
- Provider keys and spend limits on the gateway, entered by the person, never by an agent.
- Whether the $10 plan is shown as purchasable now.
- Real recordings or a restyled scene for the website's motion.
- Every deploy, every merge and every branch deletion.

## Rules that do not change

- Caps protect free and trial usage and money only, never the person's own things.
- Feature flags default to today's behaviour, so landing a slice never changes production by itself.
- Nothing is verified against a live home or the person's data; fixture success does not qualify a live provider.
