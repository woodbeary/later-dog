import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { codexComputerWorkspace, planCodexRemote } from "./codex-placement.ts";
import { codexCheckpoint, codexPendingDispatch } from "./codex-checkpoint.ts";

it("binds a resumed cursor to the dog's native account, chat and exact saved checkpoint", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-checkpoint-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const data = join(scratch, "data");
  const account = join(scratch, "account");
  const remote = join(scratch, "remote-sessions");
  const bound = codexCheckpoint(data, account, "dog", "chat", "provider", "account");
  const cursor = randomUUID();
  const turn = randomUUID();
  const name = `2026/11/25/rollout-2026-11-25T12-00-00-${cursor}.jsonl`;
  const target = join(account, "sessions", name);
  const guest = join(remote, name);
  const meta = JSON.stringify({ type: "session_meta", payload: { id: cursor } }) + "\n";
  const last = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: turn } }) + "\n";
  mkdirSync(dirname(guest), { recursive: true });
  writeFileSync(guest, meta);
  await expect(bound.publish(cursor, remote, name, null, turn)).rejects.toThrow("omitted");
  writeFileSync(guest, meta + last);
  await bound.publish(cursor, remote, name, null, turn);
  const saved = await bound.lookup(cursor);
  expect(saved?.size).toBe(Buffer.byteLength(meta + last));
  expect(readFileSync(target, "utf8")).toBe(meta + last);
  for (const [dog, chat, provider, owner] of [["other", "chat", "provider", "account"], ["dog", "other", "provider", "account"],
    ["dog", "chat", "other", "account"], ["dog", "chat", "provider", "other"]]) {
    await expect(codexCheckpoint(data, account, dog!, chat!, provider!, owner!).lookup(cursor)).rejects.toThrow("bound to another");
  }
  writeFileSync(target, meta + last + "\n");
  await expect(bound.lookup(cursor)).rejects.toThrow("changed");
  writeFileSync(guest, meta + last + last);
  await expect(bound.publish(cursor, remote, name, saved, turn)).rejects.toThrow("newer home checkpoint");
  expect(readFileSync(target, "utf8")).toBe(meta + last + "\n");
  await expect(bound.rememberHome(cursor, join(account, name))).rejects.toThrow("unexpected");
});

it("enrolls an existing selected account rollout before the first guest turn and refuses conflicting history", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-existing-rollout-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const data = join(scratch, "data");
  const account = join(scratch, "account");
  const workspace = join(data, "task-workspaces", "dog", "chat", "a sufficiently long directory to exercise native metadata parsing");
  const binding = codexCheckpoint(data, account, "dog", "chat", "instance", "account");
  const cursor = randomUUID();
  const name = `2026/11/25/rollout-2026-11-25T12-00-00-${cursor}.jsonl`;
  const source = join(account, "sessions", name);
  const contents = JSON.stringify({ type: "session_meta", payload: { id: cursor, cwd: workspace } }) + "\n" +
    JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: "original conversation" }] } }) + "\n";
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, contents);
  expect(await binding.lookup(cursor)).toBeNull();
  await expect(binding.bindSaved(cursor, workspace + "-other")).rejects.toThrow("another session or working folder");
  const otherAccount = codexCheckpoint(data, join(scratch, "another-account"), "dog", "chat", "other-instance", "other-account");
  await expect(otherAccount.bindSaved(cursor, workspace)).rejects.toThrow("missing from its selected account");
  const duplicate = join(account, "sessions", name.replace("2026/11/25", "2026/11/24"));
  mkdirSync(dirname(duplicate), { recursive: true });
  writeFileSync(duplicate, contents);
  await expect(binding.bindSaved(cursor, workspace)).rejects.toThrow("ambiguous or unsafe");
  rmSync(duplicate);
  symlinkSync(source, duplicate);
  await expect(binding.bindSaved(cursor, workspace)).rejects.toThrow("ambiguous or unsafe");
  rmSync(duplicate);
  const bound = await binding.bindSaved(cursor, workspace);
  expect(bound.path).toBe(name);
  await binding.stage(cursor, join(scratch, "guest"), bound);
  expect(readFileSync(join(scratch, "guest", name), "utf8")).toBe(contents);
  expect(await binding.lookup(cursor)).toEqual(bound);
  await expect(otherAccount.bindSaved(cursor, workspace)).rejects.toThrow("bound to another");
  appendFileSync(source, "\n");
  await expect(binding.bindSaved(cursor, workspace)).rejects.toThrow("changed");
});

it("prepares the saved session and only the supplied image for a required computer without a home turn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-required-plan-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, "task-workspaces", "dog", "chat");
  const account = join(scratch, "account");
  const pkg = join(scratch, "node_modules", "@openai", "codex");
  for (const path of [workspace, account, join(pkg, "bin")]) mkdirSync(path, { recursive: true });
  const cli = join(pkg, "bin", "codex.js");
  writeFileSync(cli, "");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.163.0" }));
  writeFileSync(join(account, "auth.json"), JSON.stringify({ tokens: { account_id: "selected", access_token: "scoped", refresh_token: "only-home" } }));
  const cursor = randomUUID();
  const name = `2026/11/25/rollout-2026-11-25T12-00-00-${cursor}.jsonl`;
  const path = join(account, "sessions", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: cursor, cwd: workspace } }) + "\n");
  const image = join(scratch, "original.png");
  writeFileSync(image, "image");
  const input = { dataDir: scratch, botId: "dog", threadId: "chat", instanceId: "provider", cli, cwd: workspace, env: { CODEX_HOME: account },
    cursor, opener: { proxyPath: "/proxy", open: async () => { throw new Error("unnecessary"); } }, guardShell: false, refresh: async () => {} };
  expect((await planCodexRemote(input)).stay).toContain("saving the current native session on the home");
  const placed = await planCodexRemote({ ...input, required: true, images: [{ path: image, mime: "image/png", bytes: 5 }] });
  if (!placed.plan) throw new Error(placed.stay);
  const sessions = placed.plan.launch.roots.find(root => root.id === "sessions")!;
  expect(sessions.files).toEqual([name]);
  expect(readFileSync(join(sessions.path, name))).toEqual(readFileSync(path));
  expect(placed.selectedRollout(cursor, join(sessions.path, name))).toEqual({ name, needsSelection: false });
  expect(() => placed.selectedRollout(randomUUID(), join(sessions.path, name))).toThrow();
  expect(readFileSync(placed.imagePaths[0]!, "utf8")).toBe("image");
  expect(placed.plan.launch.roots.find(root => root.id === "images")).toMatchObject({ files: ["0.png"], readOnly: true, writable: false });
  expect(JSON.stringify(placed.plan)).not.toContain("only-home");
});

it("stages a large selected Codex rollout and atomically publishes only the matching completed turn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-large-rollout-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const account = join(scratch, "account");
  const sessions = join(account, "sessions");
  const staged = join(scratch, "staged");
  const cursor = randomUUID();
  const turn = randomUUID();
  const name = `2026/11/25/rollout-2026-11-25T12-00-00-${cursor}.jsonl`;
  const path = join(sessions, name);
  const guest = join(staged, name);
  mkdirSync(dirname(path), { recursive: true });
  const out = openSync(path, "wx");
  try {
    writeFileSync(out, JSON.stringify({ type: "session_meta", payload: { instructions: "x".repeat(1024 * 1024), id: cursor } }) + "\n");
    const block = Buffer.from(JSON.stringify({ type: "response_item", payload: { content: "x".repeat(1024 * 1024) } }) + "\n");
    for (let i = 0; i < 129; i++) writeSync(out, block);
  } finally { closeSync(out); }
  const bound = codexCheckpoint(join(scratch, "data"), account, "dog", "thread", "instance", "account");
  await bound.rememberHome(cursor, path);
  const before = (await bound.lookup(cursor))!;
  expect(before.size).toBeGreaterThan(128 * 1024 * 1024);
  await bound.stage(cursor, staged, before);
  expect(statSync(guest).size).toBe(before.size);
  const decoy = { type: "response_item", payload: { nested: { type: "task_complete", turn_id: turn } } };
  appendFileSync(guest, JSON.stringify(decoy) + "\n");
  await expect(bound.publish(cursor, staged, name, before, turn)).rejects.toThrow("omitted");
  expect(statSync(path).size).toBe(before.size);
  const complete = { type: "event_msg", payload: { type: "task_complete", last_agent_message: "bye".repeat(450000), turn_id: turn } };
  appendFileSync(guest, JSON.stringify(complete));
  await expect(bound.publish(cursor, staged, name, before, turn)).rejects.toThrow("omitted");
  appendFileSync(guest, "\n");
  let heartbeats = 0;
  const indicator = setInterval(() => { heartbeats++; }, 5);
  try { await bound.publish(cursor, staged, name, before, turn); }
  finally { clearInterval(indicator); }
  expect(heartbeats).toBeGreaterThan(1);
  const after = (await bound.lookup(cursor))!;
  expect(after.size).toBe(statSync(guest).size);
  expect(after.hash).not.toBe(before.hash);
  expect(existsSync(join(staged, "auth.json"))).toBe(false);
}, 25_000);

it("keeps an unconfirmed remote dispatch across restart until its own completion", () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-dispatch-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const first = codexPendingDispatch(scratch, "dog", "chat", "first", "original-message");
  const second = codexPendingDispatch(scratch, "dog", "chat", "second", "new-message");
  expect(first.has()).toBe(false);
  first.start();
  expect(second.has()).toBe(true);
  expect(second.sameSource()).toBe(false);
  expect(codexPendingDispatch(scratch, "dog", "chat", "restart", "original-message").sameSource()).toBe(true);
  second.clear();
  expect(first.has()).toBe(true);
  second.start();
  first.clear();
  expect(second.has()).toBe(true);
  expect(codexPendingDispatch(scratch, "other", "chat", "first").has()).toBe(false);
  second.clear();
  expect(first.has()).toBe(false);
});

it("places the normal task workspace and rejects other chats and linked paths", async () => {
  const data = mkdtempSync(join(tmpdir(), "codex-placement-"));
  onTestFinished(() => rmSync(data, { recursive: true, force: true }));
  const dog = join(data, "workspaces", "dog");
  const task = join(data, "task-workspaces", "dog", "chat");
  const sibling = join(data, "task-workspaces", "dog", "other");
  for (const path of [dog, task, sibling]) mkdirSync(path, { recursive: true });
  symlinkSync(sibling, join(task, "linked"), "dir");
  expect(await codexComputerWorkspace(data, "dog", "chat", dog)).toBe(true);
  expect(await codexComputerWorkspace(data, "dog", "chat", task)).toBe(true);
  expect(await codexComputerWorkspace(data, "dog", "chat", sibling)).toBe(false);
  expect(await codexComputerWorkspace(data, "dog", "chat", join(task, "linked"))).toBe(false);
  expect(await codexComputerWorkspace(data, "other", "chat", dog)).toBe(false);
});

it("after a first start that never saved its session, the retry fetches it from the computer or starts fresh instead of refusing", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-missing-plan-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, "task-workspaces", "dog", "chat");
  const account = join(scratch, "account");
  const pkg = join(scratch, "node_modules", "@openai", "codex");
  for (const path of [workspace, account, join(pkg, "bin")]) mkdirSync(path, { recursive: true });
  const cli = join(pkg, "bin", "codex.js");
  writeFileSync(cli, "");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.163.0" }));
  writeFileSync(join(account, "auth.json"), JSON.stringify({ tokens: { account_id: "selected", access_token: "scoped", refresh_token: "only-home" } }));
  const cursor = randomUUID();
  const input = { dataDir: scratch, botId: "dog", threadId: "chat", instanceId: "provider", cli, cwd: workspace, env: { CODEX_HOME: account },
    cursor, required: true, opener: { proxyPath: "/proxy", open: async () => { throw new Error("unnecessary"); } }, guardShell: false, refresh: async () => {} };
  const fresh = await planCodexRemote({ ...input, recover: async () => null });
  if (!fresh.plan) throw new Error(fresh.stay);
  expect(fresh.fresh).toBe(true);
  expect(fresh.plan.launch.roots.find(root => root.id === "sessions")!.files).toEqual([]);
  const name = `2026/11/26/rollout-2026-11-26T16-34-57-${cursor}.jsonl`;
  const bytes = Buffer.from(JSON.stringify({ type: "session_meta", payload: { id: cursor, cwd: workspace } }) + "\n");
  const recovered = await planCodexRemote({ ...input, recover: async () => ({ name, bytes }) });
  if (!recovered.plan) throw new Error(recovered.stay);
  expect(recovered.fresh).toBe(false);
  expect(recovered.plan.launch.roots.find(root => root.id === "sessions")!.files).toEqual([name]);
  expect(readFileSync(join(account, "sessions", name))).toEqual(bytes);
  const other = randomUUID();
  const wrong = await planCodexRemote({ ...input, cursor: other, recover: async () => ({ name: name.replace(cursor, other), bytes }) });
  expect(wrong.plan && wrong.fresh).toBe(true);
});
