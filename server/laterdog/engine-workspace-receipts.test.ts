import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { engineInventory, workspaceRecovery, type EngineFile, type EngineFileRoot } from "./engine-files.ts";
import { commandLink, RemoteSession } from "./engine-remote.ts";
import { WorkspaceReceipts } from "./engine-workspace-receipts.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const taskState = (folder: string, task: string) => join(folder, sha(task).slice(0, 32) + ".json");
const legacy = (state: string, root: EngineFileRoot) => state + ".workspace-" + sha(root.path) + ".json";
const relayPath = fileURLToPath(new URL("./engine-relay.ts", import.meta.url));
const directories: string[] = [];
const connections: WorkspaceReceipts[] = [];

afterEach(() => {
  for (const receipt of connections.splice(0)) receipt.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  directories.push(dir);
  const state = join(dir, "state");
  mkdirSync(state);
  const root = (name: string, id = "workspace"): EngineFileRoot => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    return { id, path, writable: true, streamedTree: true };
  };
  const open = (scope: EngineFileRoot, task: string) => {
    const connection = new WorkspaceReceipts(scope, taskState(state, task));
    connections.push(connection);
    return connection;
  };
  return { state, root, open };
}

function write(root: EngineFileRoot, content: string, name = "notes") {
  writeFileSync(join(root.path, name), content);
  return engineInventory([root]);
}

it("finds the prior task's exact on-disk receipt and distinguishes a home edit, guest edit, and real conflict", () => {
  const { state, root, open } = fixture();
  const home = root("home"), guest = root("guest");
  const original = write(guest, "saved from first task");
  writeFileSync(legacy(taskState(state, "old"), guest), JSON.stringify(original));
  const receipt = open(guest, "new");
  const prior = receipt.read();
  expect(prior).toEqual(original);
  const advancedHome = write(home, "edited at home");
  expect(workspaceRecovery("workspace", advancedHome, original, prior)).toEqual([]);
  const advancedGuest = write(guest, "edited on the guest");
  expect(() => workspaceRecovery("workspace", advancedHome, advancedGuest, prior)).toThrow("Both copies were preserved");
  expect(readFileSync(join(home.path, "notes"), "utf8")).toBe("edited at home");
  expect(readFileSync(join(guest.path, "notes"), "utf8")).toBe("edited on the guest");
  const restoredHome = write(home, "saved from first task");
  expect(workspaceRecovery("workspace", restoredHome, advancedGuest, prior)).toEqual([
    expect.objectContaining({ root: "workspace", path: "notes", hash: sha("edited on the guest") }),
  ]);
});

it("retains two overlapping writers and accepts convergence before allowing the next home edit", () => {
  const { root, open } = fixture();
  const scope = root("guest");
  const original = write(scope, "common parent");
  const seed = open(scope, "seed");
  seed.read();
  seed.save(original);
  const first = open(scope, "first"), second = open(scope, "second");
  expect(first.read()).toEqual(original);
  expect(second.read()).toEqual(original);
  const left = write(scope, "first branch");
  first.save(left);
  const right = write(scope, "second branch");
  second.save(right);
  const third = open(scope, "third");
  const ambiguous = third.read();
  expect(ambiguous).toEqual([expect.objectContaining({ path: "notes", uncertain: true })]);
  expect(() => workspaceRecovery("workspace", left, right, ambiguous)).toThrow("conflicting shared checkpoints");
  expect(workspaceRecovery("workspace", right, right, ambiguous)).toEqual([]);
  third.save(right);
  const next = open(scope, "fourth").read();
  expect(next).toEqual(right);
  expect(workspaceRecovery("workspace", left, right, next)).toEqual([]);
});

it("preserves file absence in a competing receipt and agrees on unchanged paths across both branches", () => {
  const { root, open } = fixture();
  const scope = root("guest");
  const common = write(scope, "keep");
  const a = open(scope, "a"), b = open(scope, "b");
  a.read();
  b.read();
  const added = write(scope, "another task created this", "additional");
  a.save(added);
  b.save(common);
  const prior = open(scope, "reader").read();
  expect(prior.find(file => file.path === "notes")).toEqual(common[0]);
  expect(prior.find(file => file.path === "additional")?.uncertain).toBe(true);
  expect(() => workspaceRecovery("workspace", common, added, prior)).toThrow("conflicting shared checkpoints");
  expect(workspaceRecovery("workspace", added, added, prior)).toEqual([]);
});

it("keeps unrelated physical workspace roots separate and imports an old writer's subsequent acknowledgment", () => {
  const { state, root, open } = fixture();
  const first = root("first-guest"), unrelated = root("elsewhere");
  const oldTask = taskState(state, "prior");
  const initial = write(first, "initial");
  writeFileSync(legacy(oldTask, first), JSON.stringify(initial));
  expect(open(unrelated, "new").read()).toEqual([]);
  const current = open(first, "new");
  expect(current.read()).toEqual(initial);
  const advanced = write(first, "another legacy acknowledgment");
  writeFileSync(legacy(oldTask, first), JSON.stringify(advanced));
  expect(open(first, "third").read()).toEqual(advanced);
  current.save(initial);
  expect(open(first, "fourth").read()[0]?.uncertain).toBe(true);
});

it("uses the real relay to admit a sibling workspace baseline while keeping provider sessions scoped to the selected native binding", async () => {
  const { state, root } = fixture();
  const workspace = root("memory"), provider = root("sessions", "providerSessions");
  const previousTask = taskState(state, "other"), currentTask = taskState(state, "current");
  const workspaceFiles = write(workspace, "acknowledged workspace");
  writeFileSync(legacy(previousTask, workspace), JSON.stringify(workspaceFiles));
  const otherSessions = write(provider, "another account", "other.jsonl");
  writeFileSync(legacy(previousTask, provider), JSON.stringify(otherSessions));
  const ownSessions = write(provider, "selected account", "mine.jsonl").filter(f => f.path === "mine.jsonl");
  writeFileSync(legacy(currentTask, provider), JSON.stringify(ownSessions));
  const relay = spawn(process.execPath, [relayPath], {
    env: { ...process.env, LATERDOG_ENGINE_TEST_ROOT: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(relay, "close");
  const lines = createInterface({ input: relay.stdout });
  const previous: EngineFile[] = [];
  let ready = false;
  try {
    for await (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.type === "ready") {
        relay.stdin.write(JSON.stringify({ type: "configure", id: 1, stateFile: currentTask, lockFile: currentTask + ".lock", roots: [workspace, provider], outputIds: ["workspace", "providerSessions"], names: [] }) + "\n");
      } else if (frame.type === "inventory_page" && frame.kind === "previous") previous.push(...frame.files);
      else if (frame.type === "reply" && frame.id === 1) {
        expect(frame.body.trees).toEqual(["workspace", "providerSessions"]);
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect(previous).toEqual([...workspaceFiles, ...ownSessions]);
  } finally {
    lines.close();
    relay.kill();
    await closed;
  }
});

it("retains the last acknowledged hash when an optional real relay cannot publish its working file", async () => {
  const { state, root, open } = fixture();
  const home = root("local"), physical = root("physical");
  const initial = write(home, "baseline");
  const guest: EngineFileRoot = { ...home, path: join(physical.path, home.path) };
  const stateFile = taskState(state, "optional");
  const session = new RemoteSession(commandLink(process.execPath, [relayPath], {
    ...process.env, LATERDOG_ENGINE_TEST_ROOT: physical.path,
  }), {
    cli: process.execPath,
    args: ["-e", "process.stdin.once('data', () => { require('node:fs').writeFileSync('notes', 'guest change'); console.log(JSON.stringify({type:'result'})); });"],
    cwd: home.path, env: {}, roots: [home], outputIds: ["workspace"], requireCompleteCheckpoint: false,
    mcp: {}, hooks: [], hookEnv: {}, socketPath: join(state, "run.sock"), stateFile, lockFile: stateFile + ".lock",
  });
  const stdout: string[] = [];
  session.on("stdout", chunk => stdout.push(String(chunk)));
  try {
    await session.start();
    write(home, "changed at home after launch");
    const stopped = once(session, "link-closed");
    session.write(Buffer.from("continue\n"));
    expect(await stopped).toEqual(["incomplete checkpoint"]);
    expect(stdout.join("")).not.toContain('"type":"result"');
    expect(session.conflicts.length).toBeGreaterThan(0);
    expect(readFileSync(join(home.path, "notes"), "utf8")).toBe("changed at home after launch");
    expect(readFileSync(join(guest.path, "notes"), "utf8")).toBe("guest change");
    expect(open(guest, "later").read()).toEqual(initial);
  } finally {
    session.close();
  }
}, 15000);

it("commits independent relay processes against the same prior generation without losing a receipt", async () => {
  const { state, root, open } = fixture();
  const scope = root("guest");
  const common = write(scope, "original");
  const seed = open(scope, "seed");
  seed.read();
  seed.save(common);
  const moduleUrl = new URL("./engine-workspace-receipts.ts", import.meta.url).href;
  const script = [
    'const {WorkspaceReceipts} = await import(process.argv[1]);',
    'const [root,state,files] = JSON.parse(process.argv[2]);',
    'const db = new WorkspaceReceipts(root,state);',
    'const prior = db.read();',
    'process.once("message",()=>{ db.save(files); db.close(); process.disconnect(); });',
    'process.send(prior);',
  ].join("\n");
  const rows = ["left", "right"].map(value => write(scope, value));
  const peers = rows.map((files, i) => spawn(process.execPath, [
    "--input-type=module", "-e", script, moduleUrl, JSON.stringify([scope, taskState(state, "actor-" + i), files]),
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  const exits = peers.map(peer => once(peer, "close"));
  const closed = Promise.all(exits);
  try {
    const parents = await Promise.all(peers.map((peer, index) => Promise.race([
      once(peer, "message"),
      exits[index]!.then((): never => { throw Error("Writer exited before reading its workspace receipt"); }),
    ])));
    expect(parents.map(([prior]) => prior)).toEqual([common, common]);
    for (const peer of peers) peer.send("save");
    expect((await closed).map(([code]) => code)).toEqual([0, 0]);
    const result = open(scope, "reader").read();
    expect(result[0]?.uncertain).toBe(true);
    expect(() => workspaceRecovery("workspace", rows[0]!, rows[1]!, result)).toThrow("conflicting shared checkpoints");
  } finally {
    for (const peer of peers) if (peer.exitCode === null && peer.signalCode === null) peer.kill();
    await closed;
  }
}, 15000);
