# Fresh scratch directories for isolated checks and publishing

Branch: `clover/fresh-scratch-guidance-20261109`. Base: `25762902ef85a2c83f18a9bdd7bb371ca00b4162`.

## Cause

Three authorized jobs stalled on a recursive cleanup that only existed to reuse a folder name.
Root reported them; this record does not independently reproduce them.

| Dog | Request | Command that waited | Continuation |
| --- | --- | --- | --- |
| TASK | `2ec3630c` | recursive delete of an earlier work folder | Root denied it; the job continued in a fresh directory |
| Patch | `7d9c30ee` | recursive delete of an earlier work folder | Root denied it; the job continued in a fresh directory |
| Kennel | `39ce73e2` | `rm -rf $W` before publishing | Root denied it; publishing continued in a fresh directory |

The refusal of recursive deletes with unresolved shell paths is correct and stays as it is. The
waste came from deciding to delete at all: none of the three jobs needed the old folder gone.

## Change

`cloudHomePrompt` in `server/system-prompt.ts`, next to the heavy-command guidance, now also says:

> Use a fresh absolute scratch directory for an isolated check or publishing step. Preserve earlier
> attempts; do not delete an existing folder just to reuse its name.

No permission, tool, parser, classifier, queue or bypass changes. The TASK and Patch saved
descriptions carry the same rule; Root plans to remove those copies after this ships to the home,
so there is one source.

## Limits

This is model guidance, not enforcement. It does not prove every future command will follow it; a
dog can still ask for a recursive delete, and the existing safety refusal still decides it. It
applies to dogs on the cloud home only, from the next turn after the home runs this code.
