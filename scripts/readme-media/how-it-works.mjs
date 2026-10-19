import { writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "docs/assets/readme";

const themes = {
  light: { ink: "#1f2328", muted: "#59636e", fill: "#ffffff", strong: "#f6f8fa", edge: 0.22, strongEdge: 0.6 },
  dark: { ink: "#f0f6fc", muted: "#9198a1", fill: "#0d1117", strong: "#151b23", edge: 0.28, strongEdge: 0.6 },
};

const font = "-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, &quot;Noto Sans&quot;, Helvetica, Arial, sans-serif";

const description =
  "The Mac app and the iPhone app sign in once with your email and a code. They open your Cloud home, which keeps " +
  "your dogs, chats, routines and memory and stays on when your Mac is closed. Each dog gets its own computer in " +
  "the cloud. For AI, your dogs use the Claude, ChatGPT, Grok or Cursor plan you already have, or the free AI that " +
  "comes with later.dog. Voice lets you talk to a dog and hear it answer.";

const width = 480;

function box(theme, { x, y, w, h, title, line, strong = false, centered = false }) {
  const tx = centered ? x + w / 2 : x + 18;
  const anchor = centered ? ' text-anchor="middle"' : "";
  const titleY = line ? y + h / 2 - 4 : y + h / 2 + 5;
  return [
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="14" fill="${strong ? theme.strong : theme.fill}" stroke="${theme.ink}" stroke-opacity="${strong ? theme.strongEdge : theme.edge}" stroke-width="${strong ? 1.5 : 1}"/>`,
    `<text x="${tx}" y="${titleY}" class="title"${anchor}>${title}</text>`,
    line ? `<text x="${tx}" y="${titleY + 21}" class="text"${anchor}>${line}</text>` : "",
  ]
    .filter(Boolean)
    .join("\n  ");
}

function line(d, arrow = true) {
  return `<path d="${d}" class="line"${arrow ? ' marker-end="url(#arrow)"' : ""}/>`;
}

function render(theme) {
  const branchX = 22;
  const leaves = [
    { y: 300, title: "A computer for each dog", line: "A desktop in the cloud that you can watch" },
    { y: 380, title: "AI", line: "Your Claude, ChatGPT, Grok or Cursor plan, or free AI" },
    { y: 460, title: "Voice", line: "Talk to a dog and hear it answer" },
  ];
  const parts = [
    box(theme, { x: 0, y: 0, w: 228, h: 72, title: "Mac app", line: "On your desk", centered: true }),
    box(theme, { x: 252, y: 0, w: 228, h: 72, title: "iPhone app", line: "In your pocket", centered: true }),
    line("M114 72V88H366V72M240 88V106"),
    box(theme, { x: 90, y: 110, w: 300, h: 64, title: "Sign in once", line: "Your email and a code. No keys.", centered: true }),
    line("M240 174V196"),
    box(theme, { x: 0, y: 200, w: 480, h: 72, title: "Your Cloud home", line: "Your dogs, chats, routines and memory, always on", strong: true, centered: true }),
    line(`M${branchX} 272V${leaves.at(-1).y + 32}`, false),
    ...leaves.map((leaf) => line(`M${branchX} ${leaf.y + 32}H${branchX + 26}`)),
    ...leaves.map((leaf) => box(theme, { x: 52, y: leaf.y, w: 428, h: 64, title: leaf.title, line: leaf.line })),
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${width + 4} 530" width="${width + 4}" height="530" role="img" aria-labelledby="title desc">
  <title id="title">How later.dog works</title>
  <desc id="desc">${description}</desc>
  <style>
    .title { font: 600 16px ${font}; fill: ${theme.ink}; }
    .text { font: 400 14px ${font}; fill: ${theme.muted}; }
    .line { fill: none; stroke: ${theme.ink}; stroke-opacity: 0.5; stroke-width: 1.25; stroke-linecap: round; stroke-linejoin: round; }
  </style>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M1 1.5L9 5L1 8.5" fill="none" stroke="${theme.ink}" stroke-opacity="0.7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  ${parts.join("\n  ")}
</svg>
`;
}

for (const [name, theme] of Object.entries(themes)) {
  writeFileSync(join(outDir, `how-it-works-${name}.svg`), render(theme));
}
