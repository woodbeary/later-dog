import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { commandLink, RemoteSession } from "./engine-remote.ts";

const RELAY = fileURLToPath(new URL("./engine-relay.ts", import.meta.url));
const scratch: string[] = [];
const sessions: RemoteSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const FOLDER_CLI = `
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const [action, path, state] = process.argv.slice(2);
const log = process.env.FOLDER_LOG;
for await (const _ of process.stdin) {}
mkdirSync(path, { recursive: true });
appendFileSync(log, action + "-start\\n");
if (action === "checkpoint") {
  await new Promise(done => setTimeout(done, Number(process.env.SAVE_MS)));
  cpSync(path, process.env.DURABLE, { recursive: true });
}
appendFileSync(log, action + "-end\\n");
if (process.env.RECORD_CHECKOUT === "1") {
  const dir = join(state, createHash("sha256").update(path).digest("hex"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "checked.json"), "{}");
}
process.stdout.write(JSON.stringify({ revision: "r", manifest: "m", changed: action === "checkpoint" }) + "\\n");
`;

const ENGINE = `
const fs = require("node:fs");
let turn = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  turn += 1;
  fs.writeFileSync("turn-" + turn + ".txt", "done " + turn);
  console.log(JSON.stringify({ type: "result", turn }));
});
`;

function fixture(saveMs: number, recordCheckout = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ldsave-")));
  scratch.push(base);
  const remote = join(base, "remote");
  const work = join(base, "home", "work");
  const cli = join(base, "folder-cli.mjs");
  writeFileSync(cli, FOLDER_CLI);
  const log = join(base, "folder.log");
  const durable = join(base, "durable");
  const env = { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remote, LATERDOG_ENGINE_FOLDER_TEST_CLI: cli, FOLDER_LOG: log, SAVE_MS: String(saveMs), DURABLE: durable, RECORD_CHECKOUT: recordCheckout ? "1" : "0" };
  const open = () => {
    const session = new RemoteSession(commandLink(process.execPath, [RELAY], env), {
      cli: process.execPath, args: ["-e", ENGINE], cwd: work, env: { PATH: process.env.PATH ?? "" },
      roots: [], outputIds: [], workFolders: [{ path: work, grant: { baseUrl: "http://127.0.0.1:1/api/work-folders/v1/dog/task", guestId: "cmp_test", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } as never }],
      mcp: {}, hooks: [], hookEnv: {}, socketPath: join(base, `engine-${sessions.length}.sock`), stateFile: join(base, "state.json"), lockFile: join(base, "engine.lock"),
    });
    sessions.push(session);
    const results: number[] = [];
    session.on("stdout", (bytes: Buffer) => {
      for (const line of bytes.toString().split("\n").filter(Boolean)) results.push(JSON.parse(line).turn);
    });
    return { session, results };
  };
  const steps = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { open, steps, guestFile: (name: string) => join(remote, work, name), durableFile: (name: string) => join(durable, name) };
}

const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(done => setTimeout(done, 10));
  }
};
const ask = (session: RemoteSession) => session.write(Buffer.from(JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n"));

it("shows the reply before the work folder save finishes and starts the next turn only after it is saved", async () => {
  const f = fixture(1_500);
  const { session, results } = f.open();
  await session.start();
  ask(session);
  await until(() => results.includes(1));
  expect(f.steps()).not.toContain("checkpoint-end");
  expect(existsSync(f.durableFile("turn-1.txt"))).toBe(false);
  ask(session);
  await until(() => results.includes(2));
  await until(() => f.steps().filter(step => step === "checkpoint-end").length === 2);
  expect(f.steps()).toEqual([
    "hydrate-start", "hydrate-end",
    "hydrate-start", "hydrate-end", "checkpoint-start", "checkpoint-end",
    "hydrate-start", "hydrate-end", "checkpoint-start", "checkpoint-end",
  ]);
  expect(readFileSync(f.durableFile("turn-1.txt"), "utf8")).toBe("done 1");
  expect(readFileSync(f.durableFile("turn-2.txt"), "utf8")).toBe("done 2");
}, 60_000);

it("keeps the turn's files on the computer when the home goes away during the save, and the next engine checks them out first", async () => {
  const f = fixture(5_000);
  const first = f.open();
  await first.session.start();
  ask(first.session);
  await until(() => first.results.includes(1) && f.steps().at(-1) === "checkpoint-start");
  first.session.close();
  await new Promise(done => setTimeout(done, 500));
  expect(f.steps()).not.toContain("checkpoint-end");
  expect(existsSync(f.durableFile("turn-1.txt"))).toBe(false);
  expect(readFileSync(f.guestFile("turn-1.txt"), "utf8")).toBe("done 1");
  const second = f.open();
  await second.session.start();
  expect(f.steps().slice(-2)).toEqual(["hydrate-start", "hydrate-end"]);
  expect(readFileSync(f.guestFile("turn-1.txt"), "utf8")).toBe("done 1");
}, 60_000);

it("skips the checkout before a prompt when the folder was checked out or saved moments ago", async () => {
  const f = fixture(200, true);
  const { session, results } = f.open();
  await session.start();
  ask(session);
  await until(() => results.includes(1));
  ask(session);
  await until(() => results.includes(2));
  await until(() => f.steps().filter(step => step === "checkpoint-end").length === 2);
  expect(f.steps()).toEqual(["hydrate-start", "hydrate-end", "checkpoint-start", "checkpoint-end", "checkpoint-start", "checkpoint-end"]);
  expect(readFileSync(f.durableFile("turn-2.txt"), "utf8")).toBe("done 2");
}, 60_000);
