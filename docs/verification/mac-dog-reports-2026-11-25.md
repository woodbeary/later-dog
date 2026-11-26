# Mac access after dog reports

A report from another of the owner's dogs no longer disables Mac access in the
conversation. The Mac lending check looks for an identified non-owner human in
user messages, conversation openers or card answers. Dog messages, automatic
answers and stored report metadata do not identify a different human.

The check runs before file actions, commands and computer control. Existing
computer selection, lent folders, terminal and screen grants, Never settings,
live-turn checks and send confirmation still apply. Stopped turns, non-owner
handoffs and unauthorized automation remain refused. Memory and recall keep their
separate owner-only conversation check. Delegation stores Mac lending separately
from that authority, including explicit denials and resumed work after restart.
Older handoffs retain their original lending provenance.

An owner turn following a webhook report can use the Mac: the report itself is
not a different human. A turn triggered by a webhook still cannot use it.

## Behavioral evidence

The new isolated server test first reproduced the exact refusal on `run_command`:
“Someone else wrote in this conversation, so it can't use your Mac.” It uses a
fake Cloud-home engine, the real Mac connector on loopback, a completed teammate
result and the stored peer-message form. The owner starts a routine in that same
one-to-one conversation. Its harmless command reads the fixture's `plan.md`.

After the change, that command returns the fixture text; read and write actions
also work. The computer-control request passes the conversation check and reaches
the fixture's unavailable screen service. That is routing proof, not a claim of a
working live screen connection. The unit matrix covers explicit other-human
senders and card answers, including a foreign identity carrying a peer marker.
Automated records and dog reports fail before the fix and pass afterward.

Initial route-fixture exploration was preserved separately: ordinary modern
teammate-result records already worked. Only the stored peer-message case is
claimed as the failing route regression. All data and computer operations are
isolated fixtures; no real user files, messages or credentials were used.

## Release

Focused behavior checks and full regression/static results are recorded in the
release handoff. This document does not claim a production release or a live Mac
connection.
