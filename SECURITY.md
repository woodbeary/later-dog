# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub's private vulnerability reporting:
  <https://github.com/woodbeary/later-dog/security/advisories/new>. The report stays visible
  only to you and the maintainers until a fix is published.
- If you cannot use GitHub, email **support@later.dog** with "Security" in the subject. Do not put
  working exploit details, tokens or anyone's data in the first email; we will reply with a private
  way to send them.

You'll get a response as soon as possible, normally within a few days. Please give us a reasonable
time to fix the problem before you publish it.

## What is in scope

- The desktop app, the later.dog server and the Cloud home image in this repository.
- The hosted services built from this repository: `accounts.later.dog` (sign-in and accounts),
  `cloud.later.dog` (each dog's computer, the included AI, voice and the plan) and
  `<id>-home.later.dog` (Cloud homes).
- The iPhone app has its own repository; report it here the same way.

Out of scope: denial of service by volume, spam to the sign-in form, and findings that need a
compromised Mac or iPhone. Please do not test against other people's accounts or homes; make your
own account for testing.

## What Cloudflare protects, and what the code does

Every hosted service runs on Cloudflare Workers, Durable Objects and Containers.

- **From Cloudflare:** TLS on every hostname, always-on DDoS protection in front of every Worker,
  and Turnstile for the human checks below. Zone rate-limit and managed WAF rules sit in front of the
  sign-in and trial routes once the person who runs later.dog's Cloudflare account turns them on;
  they are not in this repository.
- **In accounts.later.dog:** sign-in codes are stored hashed and limited per network address and
  per email; codes to addresses with no account share a daily cap; throwaway email domains cannot
  start an account; and Turnstile is required on the web sign-in page when its secret is set.
  Asking for a code never wakes anyone's home.
- **In cloud.later.dog:** keys are stored only as SHA-256 digests. Free usage is reserved before
  each model call and settled after it, so parallel calls cannot overshoot a key's allowance;
  bodies, outputs and prompt sizes are capped; starting a free trial needs a passing Turnstile
  check. When the rate limiter is unreachable, the trial form and the chat, speech and transcription routes
  refuse; the other model routes still hold to the daily usage reservation, and the computers API
  falls back to its trial-hours allowance.
  Model calls go through Cloudflare AI Gateway with prompt logging off.
- **In Cloud homes:** a sleeping home starts only for a request carrying something the home Worker
  can check without starting it (a session, a webhook secret, or an open pairing it handed out).
  Everything else gets a resting page.

Fixture tests prove these in this repository. Whether a given setting is live in production is
recorded in the deploy docs, not here.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only**. Packaged builds allow anonymous loopback reads, but
  mutations require the desktop's private per-launch capability or a signed-in session; built-in
  agent integrations use narrower per-turn capabilities. Anything that makes it reachable from
  off-machine without a session, lets one dog reuse another turn's capability, or lets a local
  *unprivileged other user* drive it is a vulnerability. On a Cloud home (service loopback trust,
  see `docs/self-hosting.md`) a session-less loopback caller, which includes every dog's shell,
  may use only the routes in `SERVICE_ALLOW` (`server/request-auth.ts`); reaching an admin route or
  approving a card that way is a vulnerability. Known and documented, not yet closed: that caller
  keeps the Slack worker's guarded message route (`/api/bots/:id/messages/guarded`), so a dog's
  shell can post into an existing Full-access Slack thread, or open one while shared Full access is
  on, and get Full-access work done without a card. A worker-only relay token is the planned fix.
- Known and accepted: the included-services key sits in the Cloud home's environment, so a dog on
  that home can read it. It is limited by that key's own daily budgets.
- API keys live in `~/.laterdog/config.json` and are write-only through the API (`configured`
  booleans out, never values). Any path that echoes a stored secret back (API response, SSE event,
  log line, argv visible in `ps`) is a vulnerability.
- Agents run real CLIs (`claude`, `codex`, `grok`, `cursor-agent`) with the user's own privileges,
  and the permission broker is the consent layer for risky actions. Bypasses of the broker
  (approving without a user decision, spoofing the broker socket) are vulnerabilities unless that
  dog is explicitly set to **Full access**. Full access is a standing user decision to approve
  provider permission requests; it must never answer questions or silently broaden product-level
  confirmations such as credentials, routines, skills, or peer communication.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.
