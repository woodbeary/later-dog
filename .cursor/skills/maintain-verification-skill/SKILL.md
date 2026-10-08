---
name: maintain-verification-skill
description: "Keep a repository's verification skill and feature map in step with the app: update them when the app changes or a recipe stops working, and re-prove what you touched."
---

# Maintain verification skill

Use when a change moves a route, command, screen, label or side effect that a verification skill describes, or when following one of its recipes fails.

## Procedure

1. **Read what exists first:** the verification skill and its feature map. For later.dog itself these are `docs/verification/README.md` and its feature pages, `docs/laterdog/verification.md`, and the canonical `skills/laterdog/verify-laterdog/` (exported by `pnpm laterdog:skills`; never edit the exports).
2. **Decide what is wrong.** If a recipe fails because the product is broken, report the bug with its evidence. Do not rewrite the recipe until it passes.
3. **Match the change to the map.** List the routes, commands, entry points and side effects the change touched, and find each one's entry. Add entries for new surfaces, including second ways in (a menu item, a shortcut, an MCP tool). Before deleting a stale entry, search for anything that links to it or runs it.
4. **Correct commands by running them** against the real app in an isolated instance, not by reading the code alone.
5. **Re-prove the affected features** in an isolated fixture. Keep the evidence where cleanup does not reach, and write down what the fixture cannot show.
6. **Keep claims in their lane.** A fixture passing shows the implementation behaves. Fixture success does not qualify a live provider, a real account or production.
