import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LastingAllowStore, lastingVerdict, onlyOwnerReached, type LastingRequest, type TurnLine } from "./lasting-allows.ts";

const owner = { alwaysAsks: false, ownerOnly: true } as const;
const search = (input: Record<string, unknown>): LastingRequest => ({ ...owner, driver: "claudeAgent", tool: "WebSearch", wholeInput: input });

describe("the allow rule", () => {
  it("offers Always only for Claude's WebSearch with its whole input", () => {
    const verdict = lastingVerdict(search({ query: "weather in oslo" }));
    expect(verdict.offered).toBe(true);
  });

  it.each([
    ["a screen key press on the person's computer", { tool: "mcp__computer__key_press", wholeInput: { keys: "cmd+enter" }, approvalScope: "local-computer" }, "screen"],
    ["a command on the lent Mac", { tool: "mcp__agents__shared_computer", wholeInput: { action: "run_command", command: "ls" } }, "screen"],
    ["a person-set command server's read_file", { tool: "mcp__notes__read_file", wholeInput: { path: "notes.txt" } }, "state"],
    ["a remote server's browser click", { tool: "mcp__hosted__browser_click", wholeInput: { selector: "button[type=submit]" } }, "state"],
    ["a remote send", { tool: "mcp__resend__emails_create", wholeInput: { to: "a@example.com" } }, "state"],
    ["a remote payment", { tool: "mcp__bank__wire_funds", wholeInput: { amount: 100 } }, "state"],
    ["a server on this machine", { tool: "mcp__local__read_file", wholeInput: { path: "/etc/hosts" } }, "state"],
    ["a remote issue search", { tool: "mcp__tracker__search_issues", wholeInput: { q: "x" } }, "state"],
    ["a Claude Edit", { tool: "Edit", wholeInput: { file_path: "a.ts", old_string: "a", new_string: "b" } }, "state"],
    ["a Claude Write", { tool: "Write", wholeInput: { file_path: "a.ts", content: "x" } }, "state"],
    ["a web fetch", { tool: "WebFetch", wholeInput: { url: "https://example.com" } }, "state"],
    ["starting a teammate's turn", { tool: "mcp__agents__delegate_bot", wholeInput: { bot: "Ada", brief: "go" } }, "teammate"],
  ] as const)("offers no Always for %s", (_name, request, why) => {
    expect(lastingVerdict({ ...owner, driver: "claudeAgent", ...request })).toEqual({ offered: false, why });
  });

  it("offers no Always when the driver did not carry the whole input", () => {
    expect(lastingVerdict({ ...owner, driver: "codex", tool: "mcp__tracker__search_issues" })).toEqual({ offered: false, why: "incomplete" });
    expect(lastingVerdict({ ...owner, driver: "codex", tool: "edit" })).toEqual({ offered: false, why: "incomplete" });
    expect(lastingVerdict({ ...owner, driver: "claudeAgent", tool: "WebSearch" })).toEqual({ offered: false, why: "incomplete" });
  });

  it("offers no Always to another driver's tool titled WebSearch", () => {
    expect(lastingVerdict({ ...owner, driver: "pi", tool: "WebSearch", wholeInput: { query: "x" } })).toEqual({ offered: false, why: "incomplete" });
  });

  it("offers no Always for a search holding a key the check sees", () => {
    expect(lastingVerdict(search({ query: "find sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 online" }))).toEqual({ offered: false, why: "secret" });
  });

  it("puts item 45's kinds and turns others reached first", () => {
    expect(lastingVerdict({ ...search({ query: "x" }), alwaysAsks: true })).toEqual({ offered: false, why: "always-asks" });
    expect(lastingVerdict({ ...search({ query: "x" }), ownerOnly: false })).toEqual({ offered: false, why: "owner-only" });
    expect(lastingVerdict({ ...search({ query: "x" }), ownerOnly: false, group: true })).toEqual({ offered: false, why: "group" });
    expect(lastingVerdict({ ...search({ query: "x" }), ownerOnly: false, group: true, alwaysAsks: true })).toEqual({ offered: false, why: "always-asks" });
  });

  it("keys the whole input with keys sorted, and nothing else", () => {
    const key = (input: Record<string, unknown>) => {
      const verdict = lastingVerdict(search(input));
      return verdict.offered ? verdict.keySha256 : "";
    };
    expect(key({ query: "x", allowed_domains: ["a.com"] })).toBe(key({ allowed_domains: ["a.com"], query: "x" }));
    expect(key({ query: "x", allowed_domains: ["a.com"] })).not.toBe(key({ query: "x", allowed_domains: ["b.com"] }));
    expect(key({ query: "x" })).not.toBe(key({ query: "x " }));
  });
});

describe("only the owner reached the turn", () => {
  const isOwner = (person: string | undefined) => person === undefined || person === "p_owner";
  const reply = (at: number, extra: Partial<TurnLine> = {}): TurnLine => ({ role: "bot", at, ...extra });
  const said = (at: number, extra: Partial<TurnLine> = {}): TurnLine => ({ role: "user", at, sender: { id: "p_owner" }, ...extra });
  const reached = (lines: TurnLine[], start = 3) => onlyOwnerReached(lines, start, isOwner, "me");

  it("passes for the owner's own prompt", () => {
    expect(reached([reply(1), said(2)])).toBe(true);
    expect(reached([reply(1, { from: { botId: "me" } }), said(2)])).toBe(true);
  });

  it("fails for a guest's message queued before the turn and delivered during it", () => {
    expect(reached([reply(1), said(2), said(4, { sender: { id: "p_guest" } })])).toBe(false);
    expect(reached([reply(1), said(2, { sender: { id: "p_guest" } }), said(2.5)])).toBe(false);
  });

  it("fails when another dog's message reached the turn, whatever its role", () => {
    expect(reached([reply(1), said(2), said(4, { peerAsk: { botId: "b", name: "Ada" } })])).toBe(false);
    expect(reached([reply(1), said(2, { from: { botId: "b" } })])).toBe(false);
    expect(reached([said(0), reply(1, { from: { botId: "me" } }), reply(4, { from: { botId: "b" } })])).toBe(false);
    expect(reached([reply(1, { from: { botId: "b" } })])).toBe(false);
    expect(reached([said(0, { sender: { id: "p_member" } }), reply(1, { from: { botId: "b" } })])).toBe(false);
  });

  it("fails for a message posted through the local API, which has no person behind it", () => {
    expect(reached([reply(1), said(2, { sender: undefined, via: "api" })])).toBe(false);
  });

  it("does not look at messages answered by an earlier turn of this dog", () => {
    expect(reached([said(0, { sender: { id: "p_guest" } }), reply(1), said(2)])).toBe(true);
  });
});

describe("the store", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "lasting-"));
    return join(dir, "lasting-allows.json");
  };
  const key = "a".repeat(64);

  it("survives a restart, stores no words, and answers only for its own dog", () => {
    const file = fresh();
    new LastingAllowStore(file).grant({ botId: "dog-1", keySha256: key, grantedBy: "p_owner", fromThreadId: "t1" });
    const reopened = new LastingAllowStore(file);
    expect(reopened.answers("dog-1", key)?.preview).toBe("Search");
    expect(reopened.answers("dog-2", key)).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toMatch(/oslo/);
  });

  it("pauses after the emergency stop and answers again after Resume", () => {
    const store = new LastingAllowStore(fresh());
    store.grant({ botId: "dog-1", keySha256: key, grantedBy: "p_owner", fromThreadId: "t1" });
    store.pause("dog-1");
    expect(store.answers("dog-1", key)).toBeUndefined();
    store.resume("dog-1");
    expect(store.answers("dog-1", key)).toBeDefined();
  });

  it("removes a deleted dog's grants", () => {
    const file = fresh();
    const store = new LastingAllowStore(file);
    store.grant({ botId: "dog-1", keySha256: key, grantedBy: "p_owner", fromThreadId: "t1" });
    store.clear("dog-1");
    expect(new LastingAllowStore(file).answers("dog-1", key)).toBeUndefined();
  });

  it("answers nothing and refuses new grants when the file cannot be read", () => {
    const file = fresh();
    writeFileSync(file, "{not json");
    expect(new LastingAllowStore(file).isUnreadable()).toBe(true);
    const store = new LastingAllowStore(file);
    expect(store.answers("dog-1", key)).toBeUndefined();
    expect(() => store.grant({ botId: "dog-1", keySha256: key, grantedBy: "p_owner", fromThreadId: "t1" })).toThrow(/could not be read/);
  });
});
