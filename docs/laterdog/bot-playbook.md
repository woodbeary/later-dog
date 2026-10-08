# Bot playbook — how people run bot teams, and how to run them in later.dog

Source: the seventeen guides at [x.ai/bot/guides](https://x.ai/bot/guides) (read in full on 2026-10-07: Grok Bot 101,
Engineering, Multiple teams, Templates, Work, Mobile app development, PMs, Designing, Support, GTM, Legal Ops, SDRs,
Marketing, Founder-Led Sales, Performance Marketing, Post-Sales, Recruiting), plus xAI's "Designing Grok Bot". The
guides are what their authors do; this page turns the practices that recur into later.dog's defaults and names the gaps.

## 1. The anatomy of a bot, and where each part lives here

Every guide describes a bot the same six ways. later.dog already has a home for each:

| Part | What the guides mean | In later.dog |
| --- | --- | --- |
| Job description | "What it owns, the KPI it's responsible for, and where it has to stop and ask you" — one lane, and the work it refuses | New Bot → **Identity** (name, job) and **Soul** (standing instructions). The starting roles below are written this way |
| Connections | the accounts it is signed into, read or draft scopes first | **Apps** (Composio-backed connectors, once a broker is configured) and per-bot **MCP servers**; engine sign-ins in Settings → AI |
| A computer | its own machine, running whether or not yours is on | **Bot's computer** (Computer / Browser / Files) on this Mac or a paired computer; a cloud computer per dog on your own Cloudflare is being built (roadmap, direction b) |
| Routines | standing work on a clock or an event; "created Disabled until I hit Enable" | **Routines** (schedules, webhooks); every routine has an enabled flag — create them paused |
| Skills | playbooks the bot replays; recorded once, reused everywhere | **Skills** per bot; the repo's canonical skills in `skills/laterdog/` (verify, orchestrate, correct, review, ship, architect, benchmark) |
| Handoffs | "the ability to hand work to another bot directly, without routing through you" | `ask_bot` / `send_to_bot` tools, @mentions, **group chats** and **teams** |

## 2. Standing rules every bot should carry

These appear in three or more guides each (counts in the digest): one job per bot (10/11), draft-then-human-send and never
auto-send, post, merge or spend (10/11), overnight routines feeding a morning list (9), bot-to-bot handoffs so the human is
not the glue (9), a chief-of-staff front door (7), a repeated correction becomes a rule (7), quiet on no-op (6), proofs with
every claim (6), fail closed and mark the unverified (5), read/draft scopes before write scopes (5). later.dog's starting
roles state them in the bot's own words; the short form:

1. **Own one lane.** Do the job in the description; hand anything else to the bot that owns it, or to the person.
2. **Draft, then the person sends.** Nothing is sent, posted, published, merged, bought or deleted without an explicit yes in
   the moment. Cloud coding agents open draft PRs and never merge (the supervisor enforces this: `merge: false` per repo).
3. **Fail closed.** An empty search is "UNVERIFIED as a search result", not a fact; never invent urgency or counts; name the
   source that failed.
4. **Quiet on no-op.** A routine that ran, looked and found nothing says one line, or nothing.
5. **Proof travels with the work.** Screenshots, check runs, the PR and the commit, the transcript link — before "done".
6. **The second correction becomes a rule.** Write it to memory (and, for engineering work, run `/correct` so the rule gets an
   enforcement in CI, not a reminder).
7. **Read before write.** Ask for read or draft scopes first; preview and confirm before any write to a system of record.

## 3. The starter roster

Each role is a job description with routines (created paused) and handoffs; pick one in New Bot → Starting role, rename it,
and adjust. The guides' rosters map onto these eight:

| Role | Owns | Routines (paused until you enable them) | Hands off to |
| --- | --- | --- | --- |
| **Chief of staff** (Bot Boss, Founder Mode, Gus) | the single front door: routes your asks to specialists and their reports back to you; the morning list; a Wednesday audit of routines that fire and get ignored | weekday morning brief; weekly routine audit | every specialist; you for anything that leaves the building |
| **Engineer** (Baltata, Quill, Rank'em Engineer) | one area of one repo; turns a task into a cloud job with explicit write scopes and proof expectations; babysits it until verified | every 30 min while jobs run: inspect, unblock, re-queue | Reviewer for independent review; you for merge |
| **Nightly audit engineer** | codebase hygiene while you sleep: dead code, bundle size, build time, i18n and parity gaps, security sweeps — one draft PR per finding | nightly at 03:00 | Engineer for anything larger than a sweep |
| **Reviewer** (Jenny, the LE auditor) | never writes product code; independent review at the exact commit, postmortems when a bot repeats a mistake, onboarding new bots with the team rules | daily 05:00 1:1 round with the team | you, with a verdict and the evidence |
| **Project manager** (Iris, Mobile Orchestrator, the projects Manager) | one project = one group chat + one roster; keeps the board current; reuses bots before proposing new ones, proposes at most five, creates one only after you say yes | hourly: anything blocked, anything stale | the roster; you for staffing |
| **Inbox manager** | read-only first line of defence across mail and chat: the three things that are both important and urgent, promises you dropped, threads going cold; drafts 0–5 replies, sends none | weekdays 09:05 and 16:05 | Chief of staff |
| **Intel scout** | what happened that affects you, open follow-ups, what you need before each meeting; Source → why it matters → one do-this | weekdays 08:00 and 17:00; 15–35 min before a meeting | Chief of staff |
| **Gatekeeper** (Fuse) | the only bot allowed to touch rate-limited APIs and live accounts; everyone else drafts and asks it | — | you for any spend |

Not copied: the guides' per-company bots (Figma production, Salesforce forecasting, Ironclad, ATS). They are the same
anatomy with different connections; write them when the connector exists.

## 4. The engineering loop, end to end

This is the "outer loop / inner loop" the Engineering, PM, SDR and Marketing guides describe, with later.dog's own pieces:

1. **You talk to one bot** (Chief of staff or an Engineer). It never writes code in the chat; its job is a clean prompt and a
   clean handoff ("dirty context stays in the outer loop").
2. **It delegates** with `delegate_cloud_job`: repository, goal and acceptance criteria, write scopes, standing instructions,
   expected proof. The job runs on the hosted supervisor (Codex Cloud on your ChatGPT plan, or a Claude Code routine).
3. **It babysits** with `inspect_cloud_job`, re-prompts through `correct_cloud_job` (a new repair task on the result branch,
   updating the same PR), and asks a paired computer only when a local step is unavoidable.
4. **The supervisor publishes** a draft PR from an isolated checkout, **verifies at the exact commit** (real behavioural
   checks; lint-only or missing evidence is blocked, never passed), and the bot that delegated the job runs
   `review_cloud_job` for an independent verdict in a separate cloud session. A bot acts only on jobs it delegated
   ([what a dog's token reaches](deployment.md#what-a-dogs-token-reaches)), so a **Reviewer** bot is handed the PR or diff.
5. **You merge.** Merge authority is a per-repository setting that stays off until the acceptance record says the loop works.
6. **Nightly audits and P0.** The Nightly audit engineer's routine files one PR per finding. A "P0" is a temporary routine
   that polls `inspect_cloud_job` every five minutes and steers — the guides warn it burns tokens; keep it for real urgency.

Scoreboard: merged PRs after verification and review, per repository per day (`metrics.merged` in the Workspace), never
tasks opened. The Workspace is the shared board the guides keep in Notion.

## 5. What the guides assume, what later.dog has, and what is still missing

| Feature the guides rely on | later.dog today | Status |
| --- | --- | --- |
| One job per bot, job-description presets | Starting roles (General, Email triage, Researcher, Coding partner, Community monitor, Operations) + the roster above | **Added tonight** (roles) |
| Draft-then-send; approval before writes | Per-bot "Ask me first / Decide for me", per-tool permissions, approval cards | Have |
| Routines, promotable from chat, paused until enabled | Routines with schedules and webhooks and an enabled flag | Have; "create paused" is a convention in the roles, not yet a one-click default |
| Bot-to-bot handoffs, group chats, teams | `ask_bot`, `send_to_bot`, @mentions, group chats, teams | Have |
| Chief-of-staff front door | A role, plus group chats | Have (role added tonight) |
| Persistent per-bot memory; corrections become rules | Memory per bot; `correct-recurring-errors` skill | Have |
| Skills recorded from a demonstration | Skills are written, not recorded | Roadmap (record-to-skill) |
| Connectors via OAuth (Gmail, Slack, Notion, Salesforce…) | Composio-backed Apps once a broker is configured; MCP servers per bot | **Gap**: needs a self-hosted broker on your Cloudflare and a Composio key — see `cloudflare/composio-broker/` and roadmap item 7 |
| Per-bot always-on cloud computer with stored logins | Local or paired computers; a Boat cloud computer with your own Boat key | Being built: one per dog on your own Cloudflare, asleep when idle (roadmap, direction b) |
| Cloud coding agents that open PRs and never merge | Codex Cloud and Claude Code routines through the supervisor, draft PRs, verification at the commit, independent review | Have — and stricter than Grok Bot, which has no verification step |
| Templates / packs ("recipe, not meal"), "Add X" links | Preset files and team packages; the Templates shelf reads any GitHub repo of packages | Have; a later.dog pack repo is roadmap |
| Approval queue / drafts folder | Approval cards in chat | Partial (cards only) |
| Gatekeeper in front of APIs | A role; connectors carry their own scopes | Partial |
| Mobile app with voice | The sidecar a phone app pairs with (`companion/`); later.dog has no phone app of its own | Roadmap |
| Secure form for secrets | Secret request card | Have |
| Built-in review agent in front of actions | Reviewer role (cloud review jobs); no classifier on chat actions | Roadmap item 6 |

## 6. Where later.dog is already more honest than the product the guides describe

- **Verification at the exact commit, with real checks or nothing.** The guides merge on "high confidence and low blast
  radius"; later.dog refuses to call a PR verified without a configured behavioural check at its current head.
- **Independent review in a separate session**, with a manifest bound to the reviewed commit.
- **Truthful limitations on every backend** (no native continuation or cancellation; completion inferred from a pushed branch
  for Claude) instead of a uniform "cloud agent" card.
- **Your subscriptions, your Cloudflare, your repo.** No usage meter owned by someone else, no later.dog server the app
  phones home to, and the acceptance record names what has and has not been proven live.
