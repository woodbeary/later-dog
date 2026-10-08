---
name: monitor-and-ship
description: "Take a published PR through its checks, current-commit verification and independent review to ready-to-merge, repair what fails, and hand the merge to the person."
---

# Monitor and ship

Use once a cloud job has a published draft PR. Stay with it until the PR is ready for the person or blocked on something only they can fix. Shipping here ends with a verified, reviewed draft PR handed over; merging stays with the person. {{TOOLS}}

## Procedure

1. **Look before acting.** `inspect_cloud_job` for the job, `laterdog_workspace` for everything else in flight. Do not start a verification, review or repair that already exists, and reuse the same `requestKey` when you retry a call.
2. **Make sure behaviour gets checked.** The repository needs a recipe: behavioural CI check names or isolated commands taken from its feature map. Lint and type checks alone prove no behaviour. Setting the recipe (`configure_verification_recipe`) needs the admin connection; a dog asks its person to enter the checks in Cloud jobs → Connect repository.
3. **Verify the current commit** with `verify_cloud_job`. It records the PR head, its check results and the configured isolated commands. No checks, a missing dependency, a moved head or an unavailable environment come back blocked, and blocked is not passed. Read the evidence, not only the verdict.
4. **Review the same commit** with the `independent-review` skill.
5. **Repair what fails.** Investigate first, then call `correct_cloud_job` with a brief that carries the original requirements and the actual failure (the failing check, the log lines, the review finding). The repair is a new run that updates the same PR. It voids earlier verification and review, so start again at step 3 for the new head.
6. **Hand it over** when verification and review both passed at the PR's current commit: the PR, the commit, the evidence and anything it does not cover. Do not call `merge_cloud_job`. The person merges, on GitHub or with "Merge under repository policy" in Cloud jobs where they have granted it.
7. **Pick up after interruptions** from `inspect_cloud_job`. The supervisor's receipts are durable, so a disconnect or restart is no reason to repeat calls. Count a merge only once the job shows `merged`.

## Report

Which PRs are ready for the person, which are blocked and on what, which repairs are running, and the limits of the evidence.
