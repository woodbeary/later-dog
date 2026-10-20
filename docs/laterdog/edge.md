# later.dog edge setup

Everything Cloudflare does in front of later.dog's Workers is written down in `deploy/laterdog/edge/`, and
`scripts/edge-apply.mjs` compares it with the live zone and account. Without `--apply` it only reads: it prints what
differs and the exact API calls it would make. With `--apply` it makes those calls, in the order below, and nothing else.

The point is to stop sign-up spam, trial farming and request floods at the edge, and to cap provider spend, without
touching any Worker's code or settings.

## Run it

```sh
source ~/.nvm/nvm.sh && nvm use 24
export CLOUDFLARE_API_TOKEN=…           # see "Token" below; the script never prints it
node scripts/edge-apply.mjs              # dry run: reads only
node scripts/edge-apply.mjs --only=rate-limits,managed-rules --apply
node scripts/edge-apply.mjs --apply      # every step marked "change", in order
```

| Flag | What it does |
| --- | --- |
| `--apply` | Writes. Before the first write it saves what it read to `~/.laterdog/edge-snapshots/<time>.json` |
| `--only=a,b` | Limits the run to these steps (names below) |
| `--prune` | Lets a ruleset step remove rules someone added in the dashboard, and the `dns` step delete extra apex or `www` records. Without it, such a step is `blocked` |
| `--rollback=<snapshot>` | Plans the way back to a saved snapshot. Add `--apply` to do it |
| `--save-state=<file>` | Writes what was read (no secrets) to a file |
| `--replay=<file>` | Reads recorded GET answers instead of the API. Read-only, refuses `--apply` |

Each step prints one status: `ok` (already matches), `change` (will be written), `blocked` (a safety check failed, the
reason is printed), `waiting` (depends on something not done yet) or `report` (only a person or a deploy can fix it).
Run the dry run again after an apply: every applied step should read `ok`.

### Token

Make the token yourself in the dashboard (My Profile, API Tokens, Create Token, Custom token). For a dry run give it
read access; for `--apply` the same list with Edit, except Workers Scripts, which stays Read (the script only reads
Workers settings, and a Workers Scripts Edit token is what can PATCH a container Worker's settings, as on 10-15). Scope
it to the later.dog zone and to this account only.

- Zone: Zone Read, Zone Settings, Zone WAF, DNS, Bot Management
- Account: AI Gateway, Workers Scripts, Turnstile

The permission names are the ones the dashboard used when this was written; they are not verified against a real token.
If a call answers 403, the error names the missing area.

## The order, and why

Rate limits and log-mode rules go first because they are the cheapest to undo: a rate limit only touches one address
that is over its limit, and log mode only records. They can still hurt real people who share one address (see the shared
address section below), so watch Security, Events after applying. Steps that can change what every request sees come later.

| # | Step | What it sets | File |
| --- | --- | --- | --- |
| 1 | `rate-limits` | R1 to R5 below | `rate-limits.json` |
| 2 | `managed-rules` | Cloudflare Managed Ruleset in log mode on `later.dog` and every subdomain, in one rule | `managed-rules.json` |
| 3 | `bots` | Bot classes stay at allow, no JavaScript detections | `bots.json` |
| 4 | `ai-gateway` | Gateway `laterdog` with spend limits (the money kill switch) | `ai-gateway.json` |
| 5 | `dns` | Apex and `www` become `AAAA 100::` (proxied) instead of the Namecheap parking records | `zone.json` |
| 6 | `zone-settings` | Always Use HTTPS, minimum TLS 1.2, HSTS for 1 day, Brotli, HTTP/3 | `zone.json` |
| 7 | `ssl-strict` | SSL mode Full (strict), only after the certificate check passes | `zone.json` |
| 8 | `workers-dev` | Reports workers.dev and preview URLs that bypass the zone rules | `workers-dev.json` |
| 9 | `turnstile` | Drops the workers.dev hostname from the trial widget, once that URL is off | `workers-dev.json` |

### 1. Rate limits

The zone allows 5 rules, counting periods of 10, 60 or 600 seconds, counted per IP and per Cloudflare data centre. Each
rule answers `429` with JSON in the shape the app already reads, for the rule's block time.

| Rule | Matches | Limit | Blocked for |
| --- | --- | --- | --- |
| R1 | `POST accounts.later.dog/api/auth/email-otp/send-verification-otp`, `/api/auth/email-otp/request-password-reset` and `/api/auth/forget-password/email-otp` (every Better Auth route that emails a code) | 3 per 10 min | 10 min |
| R2 | `POST accounts.later.dog/api/auth/sign-in/email-otp` | 10 per 10 min | 10 min |
| R3 | `POST cloud.later.dog/v1/trials/start` and `POST /trial` | 3 per 10 min | 10 min |
| R4 | everything on `cloud.later.dog` except `/v1/ai/*`, `/v1/voice/*`, `/v1/computers` and `/v1/computers/*`, `/v1/complete`, `/v1/systemone`, `/v1/trial` and `/v1/plan` | 300 per min | 1 min |
| R5 | every `*-home.later.dog` | 600 per min | 1 min |

R1 and R2 sit in front of Better Auth's own per-IP limits (5 and 10 a minute, kept in D1), so a flood stops before it costs
an email or a database write. R3 caps trial farming from one network. R4 and R5 blunt floods and home wake-up storms.

Changes from the launch plan, on purpose:

- R1 blocks instead of a managed challenge. The desktop and phone apps call these endpoints with `fetch` and can never
  solve a challenge, so a challenge would just look like an outage to them.
- R4 covers the whole `cloud.later.dog` host (including `/mcp` and `/trial`), not only `/v1/*`, except the keyed routes
  Cloud homes call. Those are:
  - the included AI, voice and decision routes (`INCLUDED_API=https://cloud.later.dog/v1` in
    `deploy/laterdog/home/wrangler*.json`), which the Worker limits per key (`INCLUDED_LIMIT`);
  - the cloud computer routes, `/v1/computers` and everything under it (create, wake, exec, screenshot, files). A home
    has no `LATERDOG_COMPUTERS_API`, so `server/laterdog/cloud-computers.ts` uses the trial connection the home was
    seeded with (`api=https://cloud.later.dog/v1`), and every dog's computer-use step makes an exec or screenshot call
    there. Every one of these needs a valid key, and the Worker caps what a key can use (computer count and minutes
    from the plan, one computer on a trial). It does not count these calls per minute; a home's own computer-use
    loop is the only thing driving them;
  - `/v1/trial` and `/v1/plan` (status and cancel), which the same connection reads.

  `/v1/plan/checkout`, `/v1/trials` and `/v1/trials/start` stay in R4 (`/v1/trials/start` is in R3 as well): people start those, not dogs.

#### Shared addresses

Every rule counts per address, so everyone behind one address shares a counter. The biggest case is Cloud homes: their
containers reach `cloud.later.dog` over the public internet through Cloudflare's container egress, and many homes in one
data centre may share an egress address (Cloudflare does not document this). Counted per address, a few busy homes would
lock every home in that data centre out of the free AI and their cloud computers for a minute at a time. That is why R4
leaves the included, computer, trial and plan routes alone. If a new route on `cloud.later.dog` is called from homes,
leave it out of R4 too, and keep it limited per key in the Worker. A test fails if R4 ever matches those routes again.

Leaving them out of R4 means a flood of requests with made-up keys to those paths reaches the Worker uncounted at the
edge; each one costs an invocation and a key lookup, then a 401. If that shows up in Security, Events, the next step is
a rate limit keyed on the `Authorization` header rather than the address (Advanced Rate Limiting), not putting these
routes back under R4.

People behind an office network or a phone carrier's CGNAT share the counters too. R1 is the one they would hit first
(three code emails from one network in 10 minutes). If real users hit it, raise `requests_per_period` and apply again.

Webhooks into homes (GitHub, Telegram and the like) arrive from a few provider addresses and share one R5 counter across
every home. At launch scale that is far below 600 a minute; it is not checked live.

A test (`scripts/edge-apply.test.ts`) fails if the sign-in or trial paths in the Workers change and these rules no longer
match them.

### 2. Managed Ruleset

One rule, `managed-all-log`, runs the Cloudflare Managed Ruleset on `later.dog` and every subdomain
(`http.host eq "later.dog" or ends_with(http.host, ".later.dog")`), with every action overridden to `log`. It is one rule
because Cloudflare refuses a second rule that executes the same managed ruleset, so a blocking rule for the site and a
logging rule for the apps cannot both exist. The script checks this before it reads anything: `managed-rules.json` with two
rules executing one ruleset stops with an error.

Log mode started on 2026-10-19 (`logModeSince`), for 48 hours (`logModeHours`). From 2026-10-21, look at Security, Events,
filtered to the Managed Ruleset. If nothing real was caught, delete the `overrides` block from `managed-all-log` in
`managed-rules.json` so the ruleset's own actions (block) apply on every host, drop "in log mode" from its `description`
and remove `logModeSince` and `logModeHours`, then apply `--only=managed-rules`. The dry run compares `overrides` both ways,
so a live rule that still logs while the file has none shows as `~ managed-all-log.action_parameters` and is put back with
the ruleset's own actions; the step's title says "in log mode" or "with its own actions" from the file. The dry run reminds
you, with the date, while log mode is on. `logModeSince` may be a date (counted from 00:00Z) or a full ISO timestamp for
the exact 48 h. If something real was caught on an app host, add a skip or a narrower override for that rule instead,
still inside this one rule.

### 3. Bots

Bot Fight Mode can challenge API and mobile-app traffic, and the apps cannot answer a challenge. All bot classes stay at
allow. DDoS protection is automatic and needs nothing here. If the marketing site ever needs a bot challenge, add it as a
custom rule scoped to `later.dog` and `www` only.

### 4. AI Gateway and spend limits

A new gateway, `laterdog`, so later.dog's budgets are not shared with other projects on `default`. Settings: authenticated,
no gateway logs (each request also sends `collectLog: false`), no cache, no rate limit, Workers AI billed as today.

Spend limits answer `429` once a provider's spend in the last 24 hours passes the limit. For the per-provider rules the
Cloud Worker already falls back on any non-OK answer: Grok to Kimi, ElevenLabs to Aura-2, Claude to the next provider.
`all-daily` has no provider filter, so it is the hard stop: once it trips, every call through the gateway gets `429`,
Kimi included once Kimi goes through `laterdog`, and the free AI and voice go dark until the 24 hours roll over.

| Rule | Provider | Limit per 24 h |
| --- | --- | --- |
| `grok-daily` | grok | $40 |
| `anthropic-daily` | anthropic | $16 |
| `elevenlabs-daily` | elevenlabs | `LATERDOG_EDGE_ELEVENLABS_USD_PER_DAY` (left out while unset; keep it unset until the ElevenLabs key is on the gateway) |
| `all-daily` | every provider | $250 |

`byok_only` ("Require provider credentials") stays off until provider keys for grok and anthropic are stored on the
gateway; the dry run after that turns it on.

Since 2026-10-19 the computers Worker calls `laterdog` (`AI_GATEWAY_ID` in `deploy/laterdog/computers/wrangler.jsonc`),
so these caps count. Grok calls carry the Worker's own key; Anthropic needs its key stored on the gateway before
`ANTHROPIC_FIRST` is turned on.

**Storing the Anthropic key.** The Worker sends Claude Haiku calls without a key, so the gateway adds the one it stores
for `anthropic` under the `default` alias. AI Gateway finds a stored key by its Secrets Store secret's name,
`<gateway>_<provider>_<alias>`, so the secret must be named `laterdog_anthropic_default`. A secret under any other name,
such as `LATERDOG_ANTHROPIC`, is never found, whatever `secret_id` a provider config names. Either:

1. In the dashboard, AI Gateway > `laterdog` > Provider Keys > Add API Key, provider Anthropic, alias `default`. The
   dashboard names the secret itself.
2. Without typing the key again, copy the stored secret under the right name, then add the provider key for `anthropic`
   with alias `default` on `laterdog` that uses it (Provider Keys in the dashboard, or the gateway's provider configs):
   `wrangler secrets-store secret duplicate <store id> --secret-id <id of LATERDOG_ANTHROPIC> --name
   laterdog_anthropic_default --scopes ai-gateway --remote`.

Attaching a secret to a gateway counts as a write to Secrets Store, so the role or token needs Secrets Store Edit. The
dry run's `ai-gateway` step says so while the key is missing. Turn Claude Haiku first on only after that line is gone:
set `ANTHROPIC_FIRST` to `"1"` in `deploy/laterdog/computers/wrangler.jsonc`, run `pnpm run eval:haiku` there, and
deploy the computers Worker. Without the key, every chat would first get a 400 from the gateway and then fall through to
Kimi.

Not verified yet: that each rule reads as one day in the dashboard (AI Gateway > `laterdog` > Settings > Spend limits).
The API only says `window` is a whole number; this file sends `86400` on the guess that it means seconds, like the
gateway's other intervals. If the dashboard shows anything else, fix `window` in `ai-gateway.json`, apply
`--only=ai-gateway`, and check again.

### 5. DNS

The apex `A 162.255.119.236` and `www CNAME parkingpage.namecheap.com` are Namecheap parking leftovers. Worker routes
already serve both hosts, so visitors never see them, but they keep a real third-party origin behind the zone. The step
overwrites each record in place (same record id) with `AAAA 100::`, proxied, the usual placeholder for Worker-only hosts.
Any further A, AAAA or CNAME on the apex or `www` would be deleted, so the step is `blocked` until you pass `--prune`.
The MX and TXT records for Namecheap mail forwarding stay.

### 6. Zone hygiene

Always Use HTTPS redirects plain HTTP. TLS 1.0 and 1.1 are refused. HSTS starts at one day without subdomains or preload, so
a mistake heals in a day. After a week with no HTTPS trouble raise `max_age` to `31536000` in `zone.json` and apply again;
add `include_subdomains` only when every subdomain is HTTPS-only. Brotli and HTTP/3 make the site lighter and faster.

### 7. Full (strict)

Before proposing Full (strict) the script opens a TLS connection to every proxied origin that is not a Worker and checks
its certificate for that hostname. Any failure blocks this step, because strict mode would turn those hosts into `526`
errors. When the `dns` step is part of the run and will apply (not `blocked` for want of `--prune`), the check uses the
records as they will be after it; otherwise it checks the records as they are. The check trusts only Node's public CA
list, so an origin with a Cloudflare Origin CA certificate (valid under Full strict) is blocked by mistake; check that
one by hand and set Full (strict) in the dashboard once you are sure; the script will keep refusing. Run alone today,
`--only=ssl-strict` is blocked by the two parking origins, which do not answer TLS for later.dog.

### 8 and 9. workers.dev and Turnstile

`laterdog-computers.lopez731.workers.dev` reaches the Cloud Worker without passing any zone rule. `workers_dev` and
`preview_urls` are already `false` in the computers `wrangler.jsonc`; a full `wrangler deploy` applies them. Never PATCH a
container Worker's settings: that once dropped its image. The supervisor keeps its workers.dev URL (desktops reach it
there) and only turns preview URLs off at its next deploy. The script reads these and reports; it never writes them.

The trial widget still lists the workers.dev hostname. The `turnstile` step drops it, but waits until the computers
Worker's workers.dev URL is really off.

## Roll back

Every `--apply` saves what it read first and prints the path:

```sh
node scripts/edge-apply.mjs --rollback="$HOME/.laterdog/edge-snapshots/<time>.json"          # see the way back
node scripts/edge-apply.mjs --rollback="$HOME/.laterdog/edge-snapshots/<time>.json" --apply
```

It puts back the rulesets (an entrypoint that did not exist becomes empty), bot settings, DNS records, zone settings, SSL
mode and widget hostnames. It never deletes the `laterdog` gateway, because a deployed Worker may name it: delete it in the
dashboard once `AI_GATEWAY_ID` no longer does. `--only` works with `--rollback` too.

Quicker, narrower ways out:

- One rate limit misfires: set its `enabled` to `false` in `rate-limits.json` and apply `--only=rate-limits`.
- A spend limit is too tight: raise `limit` in `ai-gateway.json` and apply `--only=ai-gateway`, or edit it in AI Gateway,
  laterdog, Settings, Spend limits.
- Under attack and a rule is in the way: Security, WAF in the dashboard; then copy the change back into these files, or the
  next dry run will offer to undo it.

## Check it worked

1. The dry run reads `ok` for every applied step.
2. The rulesets exist: the dry run's reads include `GET /zones/<zone>/rulesets/phases/http_ratelimit/entrypoint` and
   `.../http_request_firewall_managed/entrypoint`, which answered `10003 could not find entrypoint` before.
3. A burst of wrong codes gets `429` and sends no email (a wrong code never sends one). It blocks your own address for
   10 minutes, so run it from a network you can spare:

   ```sh
   for i in $(seq 1 12); do curl -s -w ' %{http_code}\n' -X POST https://accounts.later.dog/api/auth/sign-in/email-otp \
     -H 'content-type: application/json' -d '{"email":"edge-check@example.invalid","otp":"000000"}'; done
   ```

   Better Auth also answers `429` after 10 tries a minute, so look at the body: from the 11th request on it should be
   R2's own message, "Too many sign-in tries from this network. Wait 10 minutes, then try again."
4. The desktop and phone fixtures sign in on a test account (see [verification](verification.md)).

## Recorded live dry run

On 2026-10-19 the dry run was replayed against GET answers recorded from the live account through read-only calls (no
token on this Mac). It planned 6 changes, 1 ok (bots), 1 report (workers.dev) and 1 waiting (Turnstile), and the real TLS
check blocked `--only=ssl-strict` on both parking origins. To record your own, save each GET answer as
`{"GET <path>?<sorted query>": {"result": …, "result_info": …}}` (or `{"error": {"status", "errors"}}`) and pass the file
to `--replay`.

## Applied 2026-10-19

What the live account holds after the 2026-10-19 apply, as reported by the person who applied it (this record was not
re-read from the API when written):

- `http_ratelimit`: R1 to R5, exactly as `rate-limits.json`. That the zone took R4's `starts_with` and R5's `wildcard`
  rests on this same report.
- `http_request_firewall_managed`: one rule, `managed-all-log`, expression
  `(http.host eq "later.dog" or ends_with(http.host, ".later.dog"))`, executing `efb7b8c949ac4650a09736fc376e9aee` with
  `overrides: { action: "log" }`. The first version of this file had two rules (block on the site, log on the apps);
  Cloudflare refused the second rule executing the same managed ruleset, which is why the file now has one.
- AI Gateway `laterdog` with spend limits `grok-daily` $40, `anthropic-daily` $16 and `all-daily` $250. No
  `elevenlabs-daily` rule: `LATERDOG_EDGE_ELEVENLABS_USD_PER_DAY` stays unset until Jacob adds the ElevenLabs key.

Follow-ups:

1. From 2026-10-21 (48 hours of log mode): check Security, Events for the Managed Ruleset. With no false positives, delete
   the `overrides` block from `managed-all-log` (and the log-mode words and fields, as in section 2), run the dry run (it
   should show `~ managed-all-log.action_parameters` with the `log` override going away, plus the `description` line), then
   apply `--only=managed-rules` and run the dry run again until `managed-rules` reads `ok`. A test in
   `scripts/edge-apply.test.ts` plans exactly this switch against a live rule that still logs.
2. Run the dry run with a read token: `rate-limits`, `managed-rules` and `ai-gateway` should read `ok`. Anything else means
   the live zone and these files differ; copy the live change back here or apply.

## Not verified yet

- The spend-limit `window` is taken to be seconds (86400 = one day), like the gateway's other intervals. Check it in the
  dashboard (section 4).
- Which address Cloud home traffic to `cloud.later.dog` carries, and how many homes share it. R4 leaves the included,
  computer, trial and plan routes out for that reason; R4 and R5 still count whatever else homes send.
- That the live zone matches the "Applied 2026-10-19" record; no dry run with a token has read it back yet.
- Whether spend limits count requests sent with `collectLog: false`, and whether they price BYOK ElevenLabs. The
  ElevenLabs key's own credit quota stays the real cap there.
- Whether `byok_only` affects Workers AI (Kimi) calls through the gateway. Try it on a test gateway before the keys go in.
- Whether `PUT` may change a DNS record's type (A or CNAME to AAAA). If Cloudflare refuses, the step stops at its first
  call with nothing changed; then delete the record and add the AAAA in the dashboard.
- Rate-limit counters are kept per data centre, so a flood spread across many locations is counted in parts.
