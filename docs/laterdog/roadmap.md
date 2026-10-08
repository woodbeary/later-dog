# later.dog roadmap

The product goal: one open-source workspace the operator talks to instead of Claude Code, Codex, Cursor or Grok Bot — a
coordinator agent that spawns cloud workers, reuses connectors, MCP servers, skills and credentials, asks for a login when
it needs one and remembers it, keeps its workers going like a project manager until the work is verified, and lets the
operator switch model providers at any point between subscription plans and API keys. It should feel like Grok Bot.

This page sets the direction, maps the goal onto what exists today and lists what is next, so the order of work stays
honest.

## Direction (set 2026-10-08)

later.dog is its own project. It no longer tracks or merges from the project it started from; the attribution the
Apache License asks for is in [NOTICE](../../NOTICE). The plan, in this order:

- **a. Own repository and IP.** Done 2026-10-08: every former name is replaced by later.dog's, a test in CI
  (`scripts/brand-links.test.ts`) fails if one comes back outside NOTICE, and the repository starts from one fresh
  commit. Next: the inherited code that remains is replaced module by module, each replacement a small new file with
  its own tests.
- **b. Cloud computers on the person's own Cloudflare account.** Works, verified live 2026-10-08
  ([deploy/laterdog/computers](../../deploy/laterdog/computers/README.md): create, command, files, screenshot, live
  viewer with take-over, sleep and wake with the files kept, idle sleep). One Durable Object and
  one container per dog, using the Containers `durable_object` scheduling policy (public beta), so each dog's object
  picks its image and instance size when it starts the container. Filesystem snapshots carry the dog's files across
  sleep and wake (files only: running programs start fresh, and a snapshot only restores onto the image it was taken
  from). A live desktop the person can watch and take over in the Computer panel. Idle sleep, so a computer is billed
  for compute only while it is awake. Boat stays an optional provider. Design: [cloud-computers.md](cloud-computers.md).
- **c. Any model through Cloudflare AI Gateway.** Planned. One OpenAI-compatible endpoint on the person's own account,
  with Unified Billing (one bill, no provider keys to manage) and Auto Router (it picks a model per request), next to the
  subscription engines (Claude, Codex, Cursor).
- **d. Everything deployable to your own Cloudflare with one command.** Planned. Today the supervisor alone takes the
  steps in [cloudflare.md](cloudflare.md#first-deployment), and the connected-apps broker deploys separately.

## What already exists

| Capability | Status |
| --- | --- |
| Bots as persistent chats with memory, threads, routines (cron/interval), webhooks, approvals, skills, connected apps (Composio), MCP servers | Working; connected apps need your own Composio broker (item 7) |
| Conversation providers: Codex (ChatGPT plan), Claude Code (claude.ai login), Grok (xAI API key), OpenAI-compatible endpoints, local models | Working; model is selectable per bot and per thread |
| Durable cloud jobs (Codex Cloud), isolated PR publishing, exact-commit verification, separate-session review, repair runs, local bridge | later.dog supervisor; the live Codex round trip ran on 2026-10-08 (`acceptance-2026-10-08.md`): four draft PRs, three verified, a correction on the same PR, a restart with nothing lost |
| Each job wakes the conversation that started it | The local supervisor calls the desktop; a hosted one is pulled by the desktop every 30 s without waking its sleeping container (2026-10-08, `cloudflare.md`) |
| Per-dog supervisor access | Each dog's MCP server holds a token derived for that dog alone, live on the hosted Worker since 2026-10-08 (`deployment.md`) |
| Hosted supervisor on Cloudflare that sleeps when idle | Deployed 2026-10-06 (`cloudflare.md`) |
| Claude Code cloud as a second execution backend (routine-fired sessions) | Adapter + fixtures done; needs a routine and token to go live (`claude-routine.md`) |
| Coordinator practice: `orchestrate-cloud-work`, `monitor-and-ship`, `independent-review`, `correct-recurring-errors`, `architect`, `benchmark-checklist` | Canonical skills exported to Codex, Cursor and Claude Code |

## Next, in order

1. **Finish the live Codex round trip** (steps 1–7 in `verification.md`) and raise concurrency only on observed capacity.
   Done 2026-10-08 (`acceptance-2026-10-08.md`); concurrency stays at 4 until more than three slots are observed in use.
   State on 2026-10-07: the hosted container's Codex login is confirmed, `task-com-ai` and `txtclaw` are registered with
   their environment IDs, the desktop finds the supervisor through `~/.laterdog/supervisor.json`; the one missing input is
   the operator's `GH_TOKEN` secret (`acceptance-2026-10-06.md`).
2. **Always-on coordinator.** Today the conversation engines run where the desktop runs, so the "PM that keeps going" stops
   when the laptop closes. Since 2026-10-08 cloud jobs keep running and a job's wake-up waits on the hosted supervisor until
   the desktop is back; what is missing is a coordinator that thinks while the Mac sleeps. Run the later.dog workspace
   server (`laterdog serve` image) as a second Cloudflare container with the same R2 restore/backup pattern, wire
   `workspaceUrl` so job completions wake the coordinator bot, and give that bot an
   hourly routine that audits open jobs and counts only side effects as progress. Its Codex and
   Claude logins happen inside that container the same way as the supervisor's.
3. **Provider choice everywhere.** Conversation side is done; execution side needs per-profile backends in the Workspace UI
   (profile picker already exists) and a Cursor cloud-agents adapter (API-priced, so `billing: api-and-compute`; Cursor's
   subscription usage cannot be spent through its API). xAI has no cloud-agent product: Grok is a conversation, review and
   judge model here, and the natural *execution* use of the xAI credits is item 4.
4. **Cloudflare sandbox runner, paid by API credits.** Run `codex exec` in local mode inside a Cloudflare Sandbox with Codex's
   custom model-provider config pointed at `api.x.ai` (or another API-billed provider), credentials injected by the Worker on
   egress so the sandbox never holds a key, diff and evidence exported to R2 before the sandbox sleeps. This is the one runner
   Cloudflare documents (API-key billing), it fits the project's gate, and it turns the xAI credit balance into implementation
   capacity. Subscription-billed runners stay out until a provider offers a headless subscription login for sandboxes.
5. **Credential requests with memory.** When a worker needs a login the operator does not have stored, the coordinator asks in
   chat with a card, the operator enters the value in the app's connection settings (never in the chat transcript), and the
   value is stored once as a Worker secret or connected-app token and reused by later jobs. later.dog's own broker
   (following the Composio broker Worker in `cloudflare/composio-broker/`: per-bot scoped tokens, Worker secrets at rest)
   replaces the shared admin token.
6. **Grok Bot-grade experience.** Cloud-job cards that revive the chat when a job settles (wakeups exist; the card is UI),
   two-tier approvals (an auto-review classifier with the operator's rules, then cards with expiry), connectors first
   (@-mention a connector, screenshots as proof of work), texting-style replies, and a per-dog cloud computer on the
   person's own Cloudflare that sleeps when unused (direction b, [design and comparison](cloud-computers.md)). Trim the
   desktop build (local VM, computer-use, voice, bundled Chromium) toward ~120 MB.
   From the bot-team guides (`bot-playbook.md`): routines created paused by default with one-click enable, a drafts queue
   beside approval cards, record-a-demonstration-into-a-skill, and a later.dog pack repository for the Templates shelf so the
   starter roster installs as a team. Done 2026-10-07: the starter roster as starting roles, later.dog's own mark and dog
   mascot body; the dog vocabulary (dogs, Tricks, Fetch, Heel and Off-leash, packs); eight breeds with ten moods drawn the
   way Grok Bot draws its roster; the redrawn mark and app icon; treats.
7. **Public onboarding.** Done 2026-10-07: every user-visible string, the mark, icons and mascot are later.dog's; the hosted
   services the app used to default to (Composio broker, control plane, cloud origin, managed companion domain, admin portal,
   team-library repository) are gone — each is a `LATERDOG_*` variable with no default and the surface degrades honestly. Done
   2026-10-08: connector cards in the Apps pop-up for ten official remote MCP servers that sign in with OAuth and no key
   (`src/lib/mcp-connectors.ts`, each checked against the provider's docs or the MCP registry and its published OAuth
   metadata; proven against synthetic providers by `scripts/verify-connectors.ts`, not yet with a person signing in to each
   live service). Done 2026-10-08: the renamed dog words translated in all nine languages, and the welcome flow opening on
   a fresh install, which it never did before 0.1.3 (`docs/verification/onboarding.md`). Done 2026-10-08: the phone
   companion sidecar and `deploy/docker-compose.yml` carry later.dog's name too (direction a). Still open: the rest of the
   connector store — our own Composio broker Worker on the operator's Cloudflare, and sign-in for servers that accept only
   clients with a secret (Supabase, Hugging Face); signed and notarised macOS builds, an update feed (until then the app
   checks GitHub Releases and offers the download, `electron/release-check.mjs`), and the one-command deploy into another
   person's own Cloudflare (direction d).

## Rules that keep this honest

Fixture success never qualifies a live provider; every backend row states its real limitation; capacity numbers are targets
until observed; secrets are entered by the operator in the app or `wrangler secret put`, never relayed through an agent's chat.

## Also on the list (added 2026-10-07)

- **Stay lightweight.** Measured on 2026-10-07: the installed app idles at about 393 MB RSS across five processes
  (Electron main 92 MB, renderer 126 MB, helpers) and the local build is 642 MB on disk / 276 MB zipped. Targets:
  under 250 MB RSS at idle and under 150 MB zipped, by trimming the local VM, computer-use and voice bundles out of the
  default build (item 6) and lazy-loading the heavy panels. Launch time and idle CPU are measured the same way before and
  after every change (`benchmark-checklist` skill).
- **Spend tokens frugally.** The app adds context to every turn (system prompt, memory, tricks, tool schemas). Measure
  the overhead per turn and per bot, show it in the usage meter, and cut what does not earn its place; a harness that
  makes people hit their limits early is not one anybody wants. The token battery (user-arranged account order with
  carry-over) is the complement, not a substitute. Built 2026-10-07 and proven against a fake Claude CLI
  ([token-battery.md](token-battery.md)); still to observe: two real Claude accounts reaching their limits in one day.
- **Keep the whole suite in CI.** CI once ran only the supervisor's tests and a few others, so renaming the data folder
  broke 132 server tests without a red build (fixed 2026-10-07). CI now runs the whole vitest suite in four shards.
- **Sponsorship and animal rescue.** The Sponsor button and About link point at `support.md`; the ledger (totals, share
  donated, recipients) is published there from the first payout. A future paid plan writes the same rule into its terms
  before the first invoice.
- **Contributions.** PR and issue templates, `CONTRIBUTING.md`; review and merge stay with a person.
