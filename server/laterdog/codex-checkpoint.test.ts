import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { codexComputerWorkspace } from "./codex-placement.ts";
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

it("places the normal task workspace and rejects other chats and linked paths", () => {
  const data = mkdtempSync(join(tmpdir(), "codex-placement-"));
  onTestFinished(() => rmSync(data, { recursive: true, force: true }));
  const dog = join(data, "workspaces", "dog");
  const task = join(data, "task-workspaces", "dog", "chat");
  const sibling = join(data, "task-workspaces", "dog", "other");
  for (const path of [dog, task, sibling]) mkdirSync(path, { recursive: true });
  symlinkSync(sibling, join(task, "linked"), "dir");
  expect(codexComputerWorkspace(data, "dog", "chat", dog)).toBe(true);
  expect(codexComputerWorkspace(data, "dog", "chat", task)).toBe(true);
  expect(codexComputerWorkspace(data, "dog", "chat", sibling)).toBe(false);
  expect(codexComputerWorkspace(data, "dog", "chat", join(task, "linked"))).toBe(false);
  expect(codexComputerWorkspace(data, "other", "chat", dog)).toBe(false);
});
