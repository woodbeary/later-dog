# Publishing, verifying, reviewing and repairing PRs

**What it is.** A collected diff becomes a draft PR, published from the remote publishing host. Verification and independent review are tied to the PR's exact head commit. A correction is a new repair run on the same branch. Merging is gated by repository policy and stays with the person.

**Where a person finds it.** Cloud jobs → a collected job → Publish PR → Verify → Independent review. Corrections: Start a repair run in the job, or ask in the conversation. "Merge under repository policy" appears only for a repository that grants it.

**Prove it.** `pnpm exec vitest run server/laterdog/github.test.ts server/laterdog/supervisor.test.ts`, using real local Git repositories and a mocked GitHub API. Look for: one PR even when GitHub's response is lost; a staged patch recovered without being applied twice; no push when a file falls outside the write scopes; verification voided when the head moves; truncated or lint-only checks not counted as behavioural verification; a stale review rejected; a repair run updating the same branch and voiding earlier verdicts.

**Not proven here.** Real GitHub access or Codex Cloud. "Result collected" means a diff exists, not that it passed. Missing or incomplete checks, and missing container dependencies, block verification. A closed or merged PR needs a new implementation job.
