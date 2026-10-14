# Cloud jobs

A cloud job is coding work a dog hands to a disposable later.dog Cloud computer (see [cloud-computers.md](cloud-computers.md)).
The supervisor starts the computer, runs Claude Code on it, collects a diff, publishes a draft PR and deletes the
computer. This page covers what a job runs with, the trace it leaves behind, and what that costs.

## What a job runs with

Each job can carry four choices. Every one is optional.

| Choice | Values | Default |
| --- | --- | --- |
| `model` | a Claude model id such as `claude-opus-5-5` | the delegating dog's model, else Claude Code's own default |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | the delegating dog's effort, else Claude Code's own default |
| `account` | an account name | the delegating dog's account, else the first later.dog Cloud profile |
| `computerSize` | `small`, `standard`, `large`, `xlarge` | `small`, which is Cloudflare's `standard-1` (1/2 vCPU, 4 GiB RAM, 8 GB disk), never more than the profile's ceiling |

The person can set them in the job request, and the delegating tool can pass them to `delegate_cloud_job`. When a dog
on Claude delegates and leaves a choice out, the desktop fills it from that dog's own model, effort and account
(`LATERDOG_MODEL`, `LATERDOG_EFFORT` and `LATERDOG_ACCOUNT` in the MCP server's environment). A dog on another engine
sends nothing, so the job falls back to the defaults. Explicit values always win.

Repairs and reviews of a job inherit its choices. A review the person sends to another profile does not.

Model, effort and computer size apply only to later.dog Cloud jobs. A job on another backend (Codex Cloud, a Claude
routine) records none of them, shows none of them, and gets a `choices_ignored` event saying so.

### Computer size: the default moved from `xlarge` to `small`

Until now every new job ran on `xlarge` (`standard-4`: 4 vCPU, 12 GiB) unless the profile said otherwise. New jobs now
run on `small` (`standard-1`: 1/2 vCPU, 4 GiB RAM, 8 GB disk), which is about a third of the hourly cost when idle. A
dependency install or a large build can run out of 4 GiB or 8 GB, so a job that needs more must ask for it.

A job may ask for a size up to its profile's ceiling and never above it. The ceiling is the profile's
`maxComputerSize`, else its `computerSize`, else `small`. A profile that already set `computerSize` keeps that size as
its ceiling, but its jobs no longer default to it. To allow bigger jobs, set it on the cloud profile in the supervisor's
config:

```json
{ "id": "cloud", "label": "later.dog Cloud", "backend": "laterdog-cloud", "maxComputerSize": "large" }
```

A request above the ceiling is not refused. It is clamped, the job records the size it got, and a
`computer_size_clamped` event says "Asked for a xlarge computer; ran on large (this profile allows up to large)".

`account` picks a later.dog Cloud profile whose `account` (or profile id) matches. The profile names which
`CLAUDE_CODE_OAUTH_TOKEN_<NAME>` secret it signs in with, in `claudeTokenEnv`. If no profile matches, the job runs on the
default one and records an `account_differs` event saying so; it never fails for that. The event is recorded only when
the supervisor chose the profile. A request that named its `profileId` ran on exactly that profile and records nothing.

The job record keeps all four, and the job card and panel show them: the model and effort beside the project, and the
account, model, effort and computer size in the panel.

## The trace

Before a job's computer is deleted, the supervisor packs the computer's full event stream (`~/task/out.jsonl`, the
stream-json Claude Code writes) with gzip, removes secrets from it, and uploads it to the same R2 bucket as the rest of
the supervisor's state (`laterdog-state`, binding `STATE`). The upload goes through the supervisor Worker's existing
outbound handler, so no new credential exists anywhere. The trace is kept when a job finishes, fails or is stopped while its computer is awake. A computer that fell asleep or
is in an error state is kept for inspection instead of deleted, so its `out.jsonl` stays on it and no trace is uploaded.

- Key: `traces/<job id>.jsonl.gz`.
- Kept for 30 days by default. Set `TRACE_RETENTION_DAYS` in `deploy/laterdog/cloudflare/wrangler.jsonc` (1 to 365) and
  redeploy the Worker. The supervisor can also ask for a number of days per upload.
- Each object carries its expiry date. The Worker refuses to serve an expired trace (410), deletes it, and sweeps the
  bucket's `traces/` prefix whenever the last sweep (a marker object `meta/trace-sweep-at`) is over an hour old, checked on
  every 5-minute cron firing, so a missed firing is caught up by the next. The Worker also refuses an upload that announces
  more than 16 MB before reading it.
- A record over 64 MB keeps its last 64 MB and the job says it was cut. The cut drops the first line only when it landed
  inside it. If the packed result is over 16 MB, the computer retries with a smaller tail (32, 16, 8, 4, 2, then 1 MB)
  until it fits, so a huge or incompressible stream still leaves its end.
- Compression and scrubbing run asynchronously, and scrubbing yields to the event loop every megabyte, so a large trace
  does not stall the supervisor.
- The trace never holds up a job. Capturing has a 30 s budget. When it is captured, it is written to the supervisor's
  own disk at once and the job records it as local; the upload to R2 then runs off the tick, with retries inside the
  same 30 s, and moves the record to R2 and drops the local copy when it lands. If the upload fails, the trace stays
  local and the job records `trace_kept_locally`. If it cannot be captured or kept anywhere, or the computer had no event
  stream, the job records `trace_not_kept` with the reason.
- **Stop** takes effect within seconds: it gives the trace and progress log at most 5 s, then deletes the computer. A
  trace already being captured by the poll is reused, not captured twice.
- Secrets removed, before anything is stored:
  - the exact values the supervisor knows (the account's Claude token and any `CLAUDE_CODE_OAUTH_TOKEN_<NAME>`, the
    GitHub token, `LATERDOG_COMPUTERS_KEY`, `LATERDOG_TOKEN`), and their base64, base64url, URL-encoded and JSON-escaped
    copies, including a base64 copy inside a longer encoded string;
  - keys by prefix: Anthropic `sk-ant-`, OpenAI `sk-` and `sk-proj-`, xAI `xai-`, Slack `xox[abprs]-`, Google `AIza`,
    Stripe `sk_live_` and `rk_live_`, later.dog `ldc_` and `ldt_`, Cloudflare `cfut_`, AWS `AKIA` and `ASIA`, and GitHub
    tokens;
  - `Bearer <token>`, and whole PEM private key blocks;
  - the value of `NAME=value` and `"name": "value"` where the name contains TOKEN, SECRET, KEY, PASSWORD, PASSWD,
    CREDENTIAL or AUTH (not `author`, `keyboard` and similar words), except obvious placeholders such as `none`.

  A secret of some other shape that a job prints, under a name that does not say so, would stay in the trace, so a trace
  is as sensitive as the job's own output. Scrubbing errs toward removing too much: a field called `key` loses its value.

To read one: the job card's **Steps** shows **Save trace**, and the job panel shows **Save trace** with the date it is
kept until. Both fetch `GET /api/laterdog/jobs/<id>/trace` from the desktop app and save the result as a file. The route
needs the desktop-owner capability, the same one a change to the app needs, so a request from a dog's shell on the
loopback port is refused even though it is a GET. The desktop asks the supervisor with its supervisor token and streams
the answer through, checking the size limit as it streams, and cuts the download off if the stream breaks. A dog's token
cannot read it either: the supervisor's `GET /v1/jobs/<id>/trace` is not on the dogs' route list.

Not covered: `GET /api/laterdog/jobs/<id>` and `/patch` on the desktop app are plain GETs on loopback too, so a dog's
shell can read another dog's job and diff through them. They are left as they are here and listed in the pull request as
a follow-up.

## Cost

What was measured, and what is only worked out, are kept apart. Rates are Cloudflare's published ones as of the
documentation pages dated 2026-10-01 (R2) and 2026-10-05 (Containers).

### Computer

Measured on 2026-10-08 (see [deploy/laterdog/computers/README.md](../../deploy/laterdog/computers/README.md)): sleep takes about 5 s, and the
snapshots of an idle desktop were 358 KB and 1.6 MB of changes.

Worked out from the published rates, not measured on a job: a `small` computer costs about $0.038 an hour awake with
the CPU idle and about $0.074 flat out. A typical 30-minute job is therefore about $0.02 to $0.04 for the computer. The
default is the cheapest size.

### Snapshot storage, per job and per month

Cloudflare publishes no price for container snapshot storage. The pricing page for Containers lists memory, CPU, disk
while running and network egress, and the snapshot guide and limits page list only a 30-day time to live and a 20 GB
maximum. **Everything in this section is an estimate that assumes snapshots cost what R2 Standard costs, $0.015 per
GB-month.** If Cloudflare prices them differently, these numbers change in proportion.

Whether a job leaves a snapshot at all, from the code: the supervisor deletes the computer once it has collected the
diff, and it only snapshots when a computer sleeps first, which happens after 15 minutes without API activity or 8
hours awake. A job the supervisor keeps polling does not sleep, so the usual job leaves no snapshot. A job whose
computer sleeps leaves one that the Worker API cannot delete, and it expires 30 days after it was taken or last restored
(deleting the computer only forgets the handle).

What a snapshot weighs: a snapshot holds the computer's writable disk layer, not the image. The 358 KB and 1.6 MB
measurements agree with that, since the image itself is gigabytes. A job's layer was not measured. It holds the clone,
any installed dependencies and build output, so a figure of 0.3 to 2 GB is a guess.

| Snapshot size | Source | Storage for its full 30 days |
| --- | --- | --- |
| 1.6 MB | measured, idle desktop | $0.000024 |
| 0.3 GB | estimate, a small clone | $0.0045 |
| 2 GB | estimate, clone with installed dependencies | $0.03 |
| 20 GB | the platform maximum | $0.30 |

Per month, in steady state, every snapshot lives 30 days, so a month's cost is the number of snapshots per month times
their size times $0.015. With 100 jobs a month where every computer sleeps and averages 1 GB, that is 100 GB-months,
about $1.50 a month. The realistic case is a handful of sleeping computers, so cents. Waking a computer from its
snapshot resets the 30 days, so a computer someone keeps coming back to holds one snapshot for as long as it is used.

The sleep itself runs the container for about 5 seconds, which is about $0.00005 on a small computer.

### Trace storage

Estimated, not measured: a gzipped trace is likely 1 to 10 MB. At 10 MB, 30 days of storage is $0.00015, one upload is a
Class A operation at $0.0000045, and one download is a Class B operation at $0.00000036. A thousand jobs a month at
10 MB is 10 GB-months, which is exactly the 10 GB-month R2 free tier. Repeat downloads cost nothing in egress.

## Set up and check

See the pull request for the exact steps. In short: redeploy the supervisor Worker (`deploy/laterdog/cloudflare`) so
its outbound handler serves `traces/`, add the recommended R2 lifecycle rule as a backstop (`wrangler r2 bucket lifecycle add laterdog-state traces-backstop traces/ --expire-days 366`), and run one job.

Not verified on a live deployment: that the Worker's outbound handler is reached for `traces/` writes of this size, that
a job's `out.jsonl` packs on the real image the way the unit-tested command expects, and what a job's snapshot weighs.
