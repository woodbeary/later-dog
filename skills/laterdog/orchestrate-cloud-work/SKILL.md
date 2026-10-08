---
name: orchestrate-cloud-work
description: "Run a sustained program of repository work through later.dog's supervisor: split it into scoped cloud jobs with dependencies, follow their durable receipts, and carry each result to a verified, reviewed draft PR."
---

# Orchestrate cloud work

Use when the work is bigger than one change: several jobs, several repositories, or days of follow-up. Coding runs in the cloud through the supervisor; do not fan out parallel agents on the person's computer instead. {{TOOLS}}

## Plan

1. **Read the workspace.** `laterdog_workspace` lists repositories, account profiles, backends and their stated limits, slots in use, existing jobs and measured outcomes. `inspect_provider_access` shows a profile's sign-in and CLI capabilities, not its remaining allowance; treat allowance as unknown.
2. **Split the work by what each piece owns.** Every job gets a goal, acceptance criteria, write scopes as narrow as the change allows, and `dependencies` on the jobs it builds on. The supervisor holds a job until its dependencies are ready and runs overlapping scopes in one repository one at a time; choosing good boundaries is still your call.

## Delegate and follow

3. **`delegate_cloud_job`** for each job, with a `requestKey` tied to that intent (reuse it on a retry, never for different work), the `repository`, a `title`, a `brief` holding the goal and acceptance criteria, `writeScopes`, `dependencies`, the `profileId`, and the program's `standingInstructions` on every job. A brief goes to the cloud: no credentials or private material in it.
4. **`inspect_cloud_job`** reads a job and its receipts without touching the provider task. Never resume a task just to see whether it is alive.
5. **A finished job is a result to judge, not proof.** Read the diff with `collect_cloud_diff`, publish it as a draft PR with `publish_cloud_job` (only the remote publishing host can; a supervisor on the local computer refuses), then follow the `monitor-and-ship` skill. Merging stays with the person.

## When something goes wrong

6. **Submission uncertain:** never submit again. Look for the task with `list_provider_tasks` on the job's profile and attach it with `reconcile_cloud_task`. Only if that list shows no task may `cancel_cloud_job` with `acknowledgeUnknown` free the slot.
7. **Cancelling** stops queued work. A native task that was already submitted cannot be cancelled; the job records the request and the task may keep running.
8. **Limits stay visible.** This adapter cannot create a cloud environment, continue a native task or cancel a submitted one. A follow-up change is a new repair run (`correct_cloud_job`) on the published branch.
9. **Local help,** only when the work truly needs a person's machine: `inspect_local_assistance` lists paired devices, and `request_local_assistance` queues a scoped request against one paired repository root. Requests wait while the device is offline, the local bot keeps its own permissions, and unrelated credentials never go in.

## Keep score

10. Record decisions, human interventions, regressions and sourced costs with `record_job_observation`. Report PRs opened, verified and merged as separate numbers, with blockers and limits. A capacity goal (a monthly PR count, a concurrency level) is a target until observations show it; raise concurrency only after they do.
