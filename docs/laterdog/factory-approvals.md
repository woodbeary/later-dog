# Factory approvals (design only)

Nothing in this page is built. It describes how merging, releasing and deploying the result of a cloud job could become
actions the supervisor performs when the person taps, and never when a dog asks.

## The problem today

A dog's token reaches `POST /v1/jobs/<id>/action` for its own jobs (`DOG_ROUTES` in `server/laterdog/dog-access.ts`),
and that route takes `publish`, `verify`, `merge` and `cancel`. `merge` is guarded only by repository settings (the
repository has `merge` authority, the job is `ready`) and `gh pr merge --match-head-commit` at the job's `headSha`.
There is no human in that path, and there is no route at all for releasing or deploying. The MCP tool `merge_cloud_job`
is annotated destructive, but the annotation is a hint to a client, not a gate.

The working rule is: workers open draft PRs, and merging stays human. Today that is a convention. The design makes it a
property of who can call what.

## Principles

1. A dog can propose; only the person's desktop can approve. The proposal is a durable record, not a tool call that
   waits.
2. What the person approves is exactly what runs. The approval is bound to a commit, a target and an expiry, and is
   checked again when it is used.
3. The supervisor performs the action with its own credentials after the approval. A dog never receives the credential,
   and an approval does not hand one over.
4. Every step leaves a receipt in the job's events, whatever the outcome.
5. Fail closed: missing evidence, a moved head, an expired approval or an unreachable supervisor all mean no action.

## The record

A new table in the supervisor's store, `approvals`, with one row per proposed action:

| Field | Meaning |
| --- | --- |
| `id` | uuid |
| `jobId` | the job whose result this is about |
| `action` | `merge`, `release` or `deploy` |
| `target` | for `merge` the PR number and base branch; for `release` the tag and the workflow; for `deploy` the named target from the repository's configuration (below) |
| `boundSha` | the commit the person is approving: the PR's `headSha` for a merge, the merge commit for a release or deploy |
| `evidence` | what the supervisor checked when the proposal was made: verification verdict, review verdict and the commit each was for |
| `requestedBy` | the dog that proposed it, or `desktop` |
| `state` | `pending`, `approved`, `declined`, `expired`, `running`, `done`, `failed`, `superseded` |
| `expiresAt` | 24 hours after the proposal by default |
| `decidedAt`, `decidedVia` | when and by which paired desktop or phone |
| `result` | the PR merge commit, run URL or deployment URL, or the failure |

A proposal is made by `POST /v1/approvals` and is refused unless the evidence a repository requires is already
present and current (the same checks `merge` makes today, plus those listed under each action). Proposing the same
action for the same job and `boundSha` again returns the existing row.

## Who can call what

- A dog's route list gains `POST /v1/approvals` and `GET /v1/approvals/<id>`, scoped to its own jobs. It loses `merge`
  from `POST /v1/jobs/<id>/action`: the action is kept for the desktop token only. The MCP tools `merge_cloud_job`,
  `release_cloud_job` and `deploy_cloud_job` become "propose" tools that return the approval's id and say it is waiting
  for the person.
- `POST /v1/approvals/<id>/decision` accepts `approve` or `decline`, and only from the desktop token or a paired
  device that is signed in as the person. A dog's token, or a token minted for a dog, is refused with 403. This is a type
  as well as a route: the decision handler takes a `Person` principal that the dog authentication cannot produce.
- There is no route to create an approved approval.

## What the person sees

The proposal arrives like other things that need the person: a card in the conversation of the dog that proposed it, a
notification through the existing outbox and phone push, and an item in the Workspace. The card shows, in plain words:

- what will happen ("Merge the pull request 'Fix the login button' into main") and the commit it covers;
- the evidence: checks passed at that commit, a review from a separate job at that commit, and any gap ("No review yet");
- the diff size, with the same changes list the job panel shows;
- **Approve** and **Not now**.

Approve is a single tap. It is a tap on a card the person can see, in the desktop app or on the phone. The same
decision is not available as text in a chat message, so a dog cannot reply "approved" on the person's behalf.

## What the supervisor does on approve

For every action, in one transaction with the state change to `running`:

1. Check the row is `pending` and not expired.
2. Re-read the live state and compare it with `boundSha`. If the head moved, set `superseded` and tell the dog and the
   person; the person approves again.
3. Re-check the evidence is still current.
4. Run the action, then record `done` or `failed` with the result, and add a job event either way.

If the supervisor restarts during `running`, recovery sets the row to `failed` with "interrupted; check the target
before retrying", the way `submission_unknown` is handled for jobs. It never reruns an action it cannot prove did not
complete.

### Merge

Today's `publisher.merge`, `gh pr merge --squash --match-head-commit <boundSha>`, moved behind the approval.
Requirements at proposal: the repository has `merge` authority, verification passed at `headSha`, an independent review
passed at `headSha`, and the PR is not a draft that the person has not seen. GitHub's own branch protection still
applies, so the supervisor cannot merge around a required check.

### Release

A release is a workflow dispatch, not a command run by the supervisor: the repository's configuration names the
workflow file (for this repo `macos.yml`) and the inputs it takes. The proposal carries the tag and the changelog
section the release would publish, and checks that a changelog heading for that version exists and is not marked
unreleased, as `docs/laterdog/releasing.md` already requires. On approval the supervisor dispatches
`gh workflow run <workflow> --ref <ref> -f release_tag=<tag>` with `boundSha` as the ref's commit. The workflow's own
secrets stay in GitHub; the supervisor holds only the right to dispatch.

### Deploy

Deploys are named targets in the repository's configuration, not commands a dog types. A target names a workflow to
dispatch (preferred, since the secrets stay in GitHub) or, for a target the person runs from their machine, nothing the
supervisor can do: those stay a copy-paste for the person. A Cloudflare deploy would be a workflow with the account's
token as a GitHub secret. The proposal states the target, its environment (preview, staging, production) and the commit.
Production targets need an approval each time. A staging or preview target could opt in to an approval that lasts for a
branch for a few hours, so repeated previews are not tedious; production never can.

## What stays out

- The supervisor does not hold Cloudflare, Apple or npm credentials. Release and deploy go through workflows that already
  hold them.
- No approval spans actions. Approving a merge does not approve the release that follows; the dog proposes it after the
  merge lands and the person decides again.
- A decline is not a failure. The dog is told, with the person's reason if they give one, and the job stays `ready`.

## Failure cases to test when it is built

- A dog calls the decision route with its own token: 403, no state change.
- A dog proposes, the head moves before the tap: `superseded`, nothing runs.
- Approval after expiry: refused.
- Two taps at once (desktop and phone): one runs it, the other sees it already decided.
- Supervisor restart while `running`: `failed`, no rerun.
- The workflow dispatch is accepted but the run fails: the row records the run URL and `failed`, the job gets an event.
- Evidence withdrawn after approval, such as a failing check on a rerun: refused at the re-check.

## Build order

1. The `approvals` store and the proposal and decision routes, with merge only, and `merge` removed from the dogs'
   route list. This closes the real gap first.
2. The card, notification and Workspace item.
3. Release by workflow dispatch.
4. Deploy targets in the repository configuration.

Open questions for the person: how long an approval lasts (24 hours is a guess), whether staging deploys may opt in to
an approval that lasts a few hours, and whether an independent review should be mandatory for every merge or only for
repositories that set it.
