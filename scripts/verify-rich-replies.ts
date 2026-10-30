import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlLaterDog } from "./control-laterdog.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "Rich replies"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Rich replies");
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
  const reply = [
    "## Your week",
    fence("mermaid", "flowchart LR\n  A[Find a café] --> B{Open now?}\n  B -->|Yes| C[Walk there]\n  B -->|No| D[Try tomorrow]"),
    fence("mermaid", "pie title Where the time went\n  \"Meetings\" : 12\n  \"Deep work\" : 18\n  \"Email\" : 6"),
    fence("mermaid", "xychart-beta\n  title \"Steps per day\"\n  x-axis [Mon, Tue, Wed, Thu, Fri]\n  y-axis \"Steps\" 0 --> 12000\n  bar [6500, 9100, 7200, 11000, 8400]\n  line [6500, 9100, 7200, 11000, 8400]"),
    "The average is $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$.",
    fence("place", JSON.stringify({ name: "Blue Bottle Coffee", address: "300 Webster St, Oakland, CA 94607", lat: 37.7989, lon: -122.2756 })),
    fence("product", JSON.stringify({ name: "Electric kettle, 1.7 L", price: "$39.99", store: "Target", url: "https://www.target.com/", image: "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png" })),
    fence("weather", JSON.stringify({ place: "Oakland, CA", unit: "F", now: { temp: 64, condition: "Partly cloudy" }, days: [
      { day: "Fri", high: 70, low: 55, condition: "Sunny" }, { day: "Sat", high: 66, low: 54, condition: "Light rain" },
      { day: "Sun", high: 61, low: 52, condition: "Thunderstorms" }, { day: "Mon", high: 63, low: 50, condition: "Fog" },
    ] })),
    fence("place", "{ \"name\": \"Not a card\" }"),
  ].join("\n\n");
  const wrapper = join(fixture.info.dataDir, "rich-claude.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  const sent = await control(["send", "--bot", bot.id, "--text", "Show me my week."]);
  await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  const { messages } = await api("GET", `/api/threads/${sent.taskId}/messages?limit=100`);
  const message = messages.find((item: { text?: string }) => item.text?.includes("Your week"));
  if (!message) throw new Error("Fixture did not produce the rich reply");
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/rich-replies-preview.tsx", route: "/__rich-replies.html", title: "Isolated later.dog rich replies",
    extraRoutes: [{ path: "/__rich-replies-fixture", handler: (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: message.text, message: { threadId: sent.taskId, messageId: message.id } }));
    } }],
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
