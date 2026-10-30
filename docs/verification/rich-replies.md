# Diagrams, charts, math and cards in replies

Start the isolated fake-engine server and renderer:

```sh
node --experimental-strip-types scripts/verify-rich-replies.ts
```

Open its printed `previewUrl`. It shows a real persisted assistant reply with a
Mermaid flowchart, a pie chart, a bar and line chart (`xychart-beta`), inline
math, a place card, a product card, a weather card, and a `place` block whose
JSON is incomplete, which must stay a plain code block. Add `?skin=atelier` for
the light skin. Ctrl-C closes the fixture and removes its data; the printed
server log is retained.

## What to check

- Every diagram draws, with **PNG** and **SVG** in its header. Both save a copy
  drawn in the light theme with plain text labels on white, so the PNG never
  fails on HTML labels. The saved PNG is twice the diagram's size.
- Pie charts in the dark skin use the readable palette in
  `src/lib/diagram-export.ts`.
- A code block whose language is a diagram type, such as `xychart-beta`, draws
  as a diagram too (`mermaidCode` in `src/lib/rich-cards.ts`).
- The place card opens directions in Apple Maps and Google Maps by its address,
  falling back to coordinates only without one. The product card falls back to
  its bag icon when the picture doesn't load.

## Focused regression checks

```sh
pnpm exec vitest run src/lib/rich-cards.test.ts src/lib/diagram-export.test.ts src/components/RichCard.test.ts server/system-prompt.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
```

Every dog's instructions carry the formats in the Replies section
(`server/laterdog/rich-replies.ts`). On test home test-desk4, fresh Grok dogs
asked for a bar chart, a flowchart, a pie chart and place, product and weather
cards wrote all of them in these formats.

This checks the web renderer. The phone app draws the same blocks in its own
code; its diagrams load the pinned Mermaid module from jsDelivr inside a
WebView.
