# Item 18: rarely used tools load on demand: a default per model, with proof

Read `/Volumes/fable-native/briefs/wave2/LEAD.md` first: it says how you work. Lane name `defer`, branch `fable/defer-by-model`.

## What the person sees today and should see instead
A person sees nothing directly; what changes is the size of a dog's first request. Loading the tools in `RARE_AGENT_TOOLS` only when a dog searches for them cut a fresh Claude dog's first request from 41,165 to 30,768 input tokens in a measurement on 2026-11-12, and a tool loaded on demand was still found and used. Today that is on for every model: `deferRareToolsEnabled` in `server/laterdog/tool-loading.ts` returns true unless the setting `LATERDOG_DEFER_RARE_TOOLS` is "0" (verified in the code). It has not been proven for the smallest Claude model or for a custom endpoint, where a model may not search for a tool it cannot see.

The handoff's earlier note that the feature is "off" was wrong; tonight's `fable/rc-next` corrects the doc (commit 37b7d5a88). Do not redo that.

## What to build
1. Make the default depend on the model: on where it has been proven, off elsewhere, with the setting able to force either way (on or off). Put the table of proven models in one new file under `server/laterdog/`, with a test that a model not in the table gets off and an unknown model gets off.
2. Check every tool on `RARE_AGENT_TOOLS` (about 32 names, `server/laterdog/tool-loading.ts`) and every place a dog's instructions or a tool's description carry a rule: a rule a dog must always follow may never live only in the description of a tool that loads on demand. The ask-first rules for sending mail and texts and the consent-page rule for connecting Google are the likely ones. List what you checked in your report; move any such rule into the fixed instructions (`server/laterdog/dog-guidance.ts`) if it is only in a description.
3. Give the real-engine proof as an exact, runnable check for the maintainer, who runs real engines on an isolated server: per model, a fresh dog's first-request input tokens with the setting on and off, and one task that needs a rare tool, showing the dog found it. Raw turn files from a run on the smallest model already exist: `/Volumes/fable-native/study/live/haiku-defer-20261113-005909/` (turn-01.json, turn-02.json, no write-up) next to `defer-on/` and `defer-off/`; read them first and say what they show.

## Done means
The default table and the force setting have tests that fail before the change; the rule audit is written in the report; the proof recipe is exact enough for someone else to run with no questions.

## Out of scope
Running a real engine yourself (never, in this lane), changing which tools are rare, anything in the phone app.

## What only a real home or phone can prove
Every number per model, and that a model on the "off" side really finds all its tools. Fixtures can only show the table works.
