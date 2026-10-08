---
name: create-verification-skill
description: "Write a verification skill for a repository: how to start it in isolation, drive what a user really does, keep evidence that survives cleanup, and map its main features, proven by running it once."
---

# Create verification skill

Use when a repository gives agents no dependable way to show that a change works, or when asked for a verification skill. later.dog's own setup is the model: `docs/verification/README.md` with `scripts/control-laterdog.ts`, and the `verify-laterdog` skill with its feature map. Use the later.dog MCP server. Tool prefixes depend on the client; discover tools by their names below.

## Procedure

1. **Find out how the app really runs,** from its code and docs: how people reach it (screens, CLI, API), the start command and the signal that it is ready, any test harness or control CLI already there, stable handles (accessible names, routes, commands, test IDs), the side effects worth checking, and how to keep a run's data separate (temporary directory, fake provider, its own port).
2. **Use the harness that exists.** If it is broken, fix it first in a draft PR; instructions written around a broken harness teach the wrong steps. If there is none, say so and propose the smallest script that would do. Never invent commands or selectors.
3. **Write `verify-<app>/SKILL.md`** where the repository's agents look for skills: in a repository laid out like later.dog, the canonical folder and then its export command; otherwise `.agents/skills/`. Give it a `name` and a `description`, then:
   - **Start:** the exact command, isolated data and the ready signal.
   - **Check:** one read-only health check whose failure says what to do next.
   - **Drive:** commands and stable handles taken from the code, never screen coordinates.
   - **Evidence:** the action, the state it produced and any side effect, kept outside anything cleanup deletes.
   - **Stop:** end only what this run started, and leave the evidence.
4. **Map the features:** `features/README.md` and one page per important feature, saying where a person meets it, how to drive it, what proves it worked and what that proof leaves open.
5. **Run it once, end to end,** on one mapped feature: start, check, drive, keep evidence, stop, then confirm the evidence is still there. A skill nobody has run is not finished. Fake only services outside the repository and say which results came from a fake: fixture success does not qualify a live provider.
6. **Feed cloud verification.** From the map, pick the CI checks and isolated commands that really exercise behaviour; they become the repository's recipe through `configure_verification_recipe`. That tool needs the admin connection, so a dog asks its person to enter the checks in Cloud jobs → Connect repository.
7. **Leave upkeep to the `maintain-verification-skill` skill.**
