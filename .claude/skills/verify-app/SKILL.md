---
name: verify-app
description: "Prove a later.dog server or conversation change on a disposable fake-engine instance, never the person's running app, before saying it works."
---

# Verify the app

The full procedure and the per-feature recipes are in `docs/verification/README.md`. In short:

1. **Start a disposable instance** in its own terminal, directly rather than through pnpm so that Ctrl-C reaches it:
   `node --experimental-strip-types scripts/control-laterdog.ts launch`
   It runs on temporary data with the fake engine only, prints its URL, PID, data directory and log path, and leaves the person's later.dog alone.
2. **Check it** from a second terminal, always passing that URL: `pnpm control:laterdog doctor --url http://127.0.0.1:PORT`. Commands that change anything refuse to guess a port; never point them at the person's app.
3. **Drive the change** with the commands on the matching recipe page (`send`, `wait`, `messages`, `ui …`). Go through `control-laterdog`, not hand-written HTTP calls.
4. **Keep the evidence:** the JSON from `wait` and `messages`, the exact commands, and the printed log path. It must show the action and the state it produced; a passing unit test alone does not prove a user flow.
5. **Stop it** with Ctrl-C. The launcher stops the one child it started and removes only its temporary data; the log stays. Never kill processes by name or delete a shared temp directory.

When the control tool cannot drive what you changed (Settings, drag and drop, the updater and similar renderer-only flows), use the nearest Electron or package smoke test and say plainly that the flow itself was not proven.
