import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { codexComputerWorkspace } from "./codex-placement.ts";
import { codexCheckpoint, codexPendingDispatch } from "./codex-checkpoint.ts";

it("binds a resumed cursor to the dog's native account, chat and exact saved checkpoint", () => {
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
  expect(() => bound.publish(cursor, remote, name, null, turn)).toThrow("omitted");
  writeFileSync(guest, meta + last);
  bound.publish(cursor, remote, name, null, turn);
  const saved = bound.lookup(cursor);
  expect(saved?.bytes.toString()).toBe(meta + last);
  for (const [dog, chat, provider, owner] of [["other", "chat", "provider", "account"], ["dog", "other", "provider", "account"],
    ["dog", "chat", "other", "account"], ["dog", "chat", "provider", "other"]]) {
    expect(() => codexCheckpoint(data, account, dog!, chat!, provider!, owner!).lookup(cursor)).toThrow("bound to another");
  }
  writeFileSync(target, meta + last + "\n");
  expect(() => bound.lookup(cursor)).toThrow("changed");
  writeFileSync(guest, meta + last + last);
  expect(() => bound.publish(cursor, remote, name, saved, turn)).toThrow("newer home checkpoint");
  expect(readFileSync(target, "utf8")).toBe(meta + last + "\n");
  expect(() => bound.rememberHome(cursor, join(account, name))).toThrow("unexpected");
});

it("keeps an unconfirmed remote dispatch across restart until its own completion", () => {
  const scratch = mkdtempSync(join(tmpdir(), "codex-dispatch-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const first = codexPendingDispatch(scratch, "dog", "chat", "first");
  const second = codexPendingDispatch(scratch, "dog", "chat", "second");
  expect(first.has()).toBe(false);
  first.start();
  expect(second.has()).toBe(true);
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
