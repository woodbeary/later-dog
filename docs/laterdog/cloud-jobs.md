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
| `computerSize` | `small`, `standard`, `large`, `xlarge` | `small`, which is Cloudflare's `standard-1` (1/2 vCPU, 4 GiB, 8 GB) |

The person can set them in the job request, and the delegating tool can pass them to `delegate_cloud_job`. When a dog
on Claude delegates and leaves a choice out, the desktop fills it from that dog's own model, effort and account
(`LATERDOG_MODEL`, `LATERDOG_EFFORT` and `LATERDOG_ACCOUNT` in the MCP server's environment). A dog on another engine
sends nothing, so the job falls back to the defaults. Explicit values always win.

Repairs and reviews of a job inherit its choices. A review the person sends to another profile does not.

`account` picks a later.dog Cloud profile whose `account` (or profile id) matches. The profile names which
`CLAUDE_CODE_OAUTH_TOKEN_<NAME>` secret it signs in with, in `claudeTokenEnv`. If no profile matches, the job runs on the
default one and records an `account_differs` event saying so; it never fails for that.

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
  bucket's `traces/` prefix once an hour from its cron trigger.
- A record over 64 MB keeps its last 64 MB, whole lines only, and the job says it was cut. A packed trace over 16 MB is
  not uploaded and the job records `trace_not_kept`.
- If the upload fails three times, the supervisor keeps the trace on its own disk under `traces/` in its data
  directory and records `trace_kept_locally`. If nothing can be kept, it records `trace_not_kept` with the reason.
- Secrets removed: the account's token values the supervisor knows, plus anything shaped like an Anthropic key or a
  GitHub token. A secret of another shape that a job prints would stay in the trace, so a trace is as sensitive as the
  job's own output.

To read one: the job card's **Steps** shows **Save trace**, and the job panel shows **Save trace** with the date it is
kept until. Both call `GET /api/laterdog/jobs/<id>/trace` on the desktop app, which asks the supervisor with the
desktop's supervisor token and streams back `application/x-ndjson` as a download. A dog's token cannot read it: the
supervisor's `GET /v1/jobs/<id>/trace` is not on the dogs' route list.

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
its outbound handler serves `traces/`, optionally add an R2 lifecycle rule as a backstop, and run one job.

Not verified on a live deployment: that the Worker's outbound handler is reached for `traces/` writes of this size, that
a job's `out.jsonl` packs on the real image the way the unit-tested command expects, and what a job's snapshot weighs.
