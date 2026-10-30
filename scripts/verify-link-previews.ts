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
  await control(["new-bot", "--name", "Links"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Links");
  const replies = [
    "Two places to start: the [later.dog site](https://later.dog/) and https://www.wikipedia.org/. This one is a picture, so it gets no card: https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
  ];
  const wrapper = join(fixture.info.dataDir, "links-claude.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify(replies))};`,
    `process.env.FAKE_CLAUDE_REPLY_STATE = ${JSON.stringify(join(fixture.info.dataDir, "links-reply-index"))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  for (const text of ["Where should I start reading?"]) {
    await control(["send", "--bot", bot.id, "--text", text]);
    await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  }
  console.log(JSON.stringify({ ...fixture.info, botId: bot.id }));
  await parkUntilSignal();
} finally { await fixture.close(); }
