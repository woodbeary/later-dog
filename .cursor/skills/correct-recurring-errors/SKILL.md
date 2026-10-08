---
name: correct-recurring-errors
description: "When the same failure has happened more than once and the evidence shows it, prevent it at the narrowest lasting place: a type or structural fix, a CI check or fixture, or a short rule in the canonical instructions."
---

# Correct recurring errors

Use when a mistake comes back: the same review finding, the same failed check, the same wrong assumption in a job brief, the same correction from the person. Once is a bug to fix. Twice is a pattern to prevent. Use the later.dog MCP server. Tool prefixes depend on the client; discover tools by their names below.

## Procedure

1. **Gather the cases.** Collect every occurrence with its evidence: job receipts from `inspect_cloud_job`, verification and review results, repair runs, the person's corrections in chat, CI logs. With fewer than two evidenced cases, fix the bug and stop.
2. **Name the cause** in one sentence: the condition that triggers it and what goes wrong. Cases without a shared cause are separate bugs.
3. **Pick the strongest prevention that fits,** in this order:
   1. Make it impossible: a type, a schema, a single source of truth, a narrower interface.
   2. Make CI catch it: a lint rule, a test, a fixture or a verification recipe (`docs/verification/`, `docs/laterdog/verification.md`).
   3. Only if neither works, write a short rule where agents will read it: `AGENTS.md`, or the canonical skill in `skills/laterdog/` followed by `pnpm laterdog:skills`. Never edit an exported copy.

   Counting on someone to spot it in review is not a prevention.
4. **Keep it narrow.** The prevention names the trigger and the failure. It does not fence off a whole area because one path through it went wrong.
5. **Show it works.** Run the prevention against the failing case (revert the fix or replay the input) and watch it fail, then against a good case and watch it pass.

## Report

The cases, the cause, the prevention and why the stronger options did not fit, what you ran to prove it, and any provider or environment limit that remains.
