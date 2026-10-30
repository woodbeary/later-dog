import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlLaterDog } from "./control-laterdog.ts";
import { fixtureApi, parkUntilSignal } from "./testing/preview-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchVerificationServer();
try {
  const api = fixtureApi(fixture.info.url);
  const control = (args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "Drafts"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Drafts");
  const draft = (body: string) => `\`\`\`draft\n${JSON.stringify({ via: "email", to: ["sam@example.com"], subject: "Lunch Friday?", id: "lunch" })}\n${body}\n\`\`\``;
  const replies = [
    `Here's a first go:\n\n${draft("Hi Sam,\n\nAre you free for lunch on Friday? Let me know.\n\nJacob")}`,
    `Warmer this time:\n\n${draft("Hi Sam,\n\nIt's been too long! Are you free for lunch on Friday? My treat.\n\nJacob")}\n\nAnd a post for X:\n\n\`\`\`draft\n{"via":"x","id":"launch"}\nThe new later.dog site is live.\n\`\`\``,
  ];
  const wrapper = join(fixture.info.dataDir, "drafts-claude.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify(replies))};`,
    `process.env.FAKE_CLAUDE_REPLY_STATE = ${JSON.stringify(join(fixture.info.dataDir, "drafts-reply-index"))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  for (const text of ["Draft an email asking Sam to lunch on Friday.", "Make it warmer, and draft a post about the site."]) {
    await control(["send", "--bot", bot.id, "--text", text]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  }
  console.log(JSON.stringify({ ...fixture.info, botId: bot.id }));
  await parkUntilSignal();
} finally { await fixture.close(); }
