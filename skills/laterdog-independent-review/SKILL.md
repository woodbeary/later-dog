---
name: independent-review
description: "Have a separate cloud session review a published PR at its exact current commit, and treat its verdict as valid for that commit only."
---

# Independent review

Use once a job's PR is published, before anyone calls it ready. The run that wrote a change does not approve it. Use the later.dog MCP server. Discover tools by the names below; client-specific prefixes may vary.

## Procedure

1. **Pin the commit.** `inspect_cloud_job` on the job: note the PR and its `headSha`.
2. **Start the review** with `review_cloud_job` and a new `requestKey`. Pass a `profileId` on another backend when one is connected; a second account on the same model is the same reviewer twice, so say which you used. The supervisor briefs a separate cloud run to read the requirements, the diff, the code around it and the tests, and to write only `.laterdog-review.json`: the `headSha`, a `verdict` of `pass` or `changes_requested`, and a `summary` of its findings and what it actually checked. That file is kept as evidence and never reaches the product branch.
3. **Let it run.** Follow the review job with `inspect_cloud_job` until it settles. Do not resume or resubmit it to see whether it is alive.
4. **Read the summary, not only the verdict.** A pass that does not say what was checked, or that admits something important could not be run or inspected, counts as a finding.
5. **Watch the head.** A new commit on the PR (a repair run, a push) voids the review; review the new head. No verdict comes from green CI or from a worker's confidence in its own work.

## Report

The PR, the commit reviewed, the reviewer's profile, the verdict, the findings, and what the reviewer could not check.
