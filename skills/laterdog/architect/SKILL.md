---
name: architect
description: "Plan a change before writing it: draft two or more designs that differ in who owns what, rule out the ones with structural problems, and pick the one that is right for the whole repository rather than the file you are in."
---

# Architect

Use before a change that adds a concept, moves where some state lives, or crosses a module boundary. A contained fix inside one module does not need it.

## Procedure

1. **Learn why it is shaped this way.** Read the code you would change, its tests and its history (`git log -p`, the PR or job that introduced it). Write today's design in a few lines: what owns which state, and who calls whom.
2. **Draft at least two designs that differ in ownership:** where the state lives, which module decides, and which side of a boundary (desktop app, supervisor, cloud job, paired computer) does the work. Renaming or reshuffling files does not make a second design.
3. **Write each one from the caller's side first:** the code a caller would write, then the types, then the modules and what each one knows.
4. **Rule designs out.** A design is out as soon as one answer is no:
   - Does every fact (a list, a limit, a format, a token rule) live in one place, with everything else generated or derived from it? The skill exports generated from `skills/laterdog/` are the pattern; hand-kept copies are not.
   - Does every piece of state have one writer? Job state, for example, is written only by the supervisor; everything else reads it through its API.
   - Is a retry, a restart or a lost response harmless? Nothing may run, submit, publish or notify twice.
   - Does it show what a backend cannot do instead of pretending? A native cloud task that cannot be cancelled stays "cancellation requested".
   - Does each process hold only the credential it needs? A dog gets its own derived token, never the admin token, and briefs carry no secrets.
   - Is each interface small next to what it hides, with one supported way to do each thing?
   - Does new later.dog behaviour get its own module under `server/laterdog/` instead of growing a shared file such as `server/index.ts`?
5. **Choose, and write the choice down** with the work (the PR description or the job brief): the designs considered, the question each one failed, and the test or fixture that will show the chosen one holds.
6. **Build to the plan.** When the code starts fighting it (the same workaround twice, a cast or `any` to get past the compiler, a lock to keep two writers apart), go back to step 2 instead of patching around it.
