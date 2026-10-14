import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS, handleToolCall } from "../../scripts/mcp-server.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import {
  LOCAL_TOOLS_ALLOWED_ROUTES, LOCAL_TOOLS_HEADER, LOCAL_TOOLS_REFUSAL, localToolsBodyRefusal, localToolsRouteRefusal, typedMessageAuthority,
} from "./local-tools-scope.ts";

interface Recorded { method: string; path: string; body: unknown }

const bot = { id: "b1", name: "Bot", threadId: "t1", tasks: [{ threadId: "t1", title: "One" }], busy: false, working: false };
const room = { id: "g1", name: "Room", threadId: "gt1", tasks: [{ threadId: "gt1", title: "One" }], busyBotId: null, working: false, memberIds: ["b1"] };
const instance = { instanceId: "claude", snapshot: { state: "available" }, models: { default: "m", options: [{ id: "m" }] }, capabilities: { effortLevels: ["high"] } };

function recorder() {
  const seen: Recorded[] = [];
  const fetcher = async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    const clean = path.split("?")[0]!;
    seen.push({ method, path: clean, body: options.body === undefined ? undefined : JSON.parse(String(options.body)) });
    if (clean === "/api/health") return { app: "laterdog" };
    if (clean === "/api/bots" && method === "GET") return { bots: [bot], groups: [room] };
    if (clean === "/api/instances") return { instances: [instance] };
    if (clean.startsWith("/api/threads/")) return { messages: [], hasMore: false };
    if (clean === "/api/search") return { hits: [] };
    if (clean === "/api/groups") return { group: room };
    if (/^\/api\/groups\/[\w-]+$/.test(clean)) return { group: room };
    if (clean.endsWith("/tasks")) return { task: { threadId: "t2", title: "New" }, bot, group: room };
    if (/\/tasks\/[\w-]+$/.test(clean)) return { task: { threadId: "t1", title: "Renamed" }, bot, group: room };
    if (clean.endsWith("/edit")) return { message: { id: "m1" } };
    return { bot, ok: true };
  };
  return { seen, fetcher };
}

const CALLS: Record<string, Array<Record<string, unknown>>> = {
  get_system_health: [{}],
  list_bots: [{}],
  get_bot_messages: [{ bot_id: "b1" }],
  send_bot_message: [{ bot_id: "b1", text: "hello" }, { bot_id: "b1", text: "hello", task_id: "t1" }],
  create_bot: [
    { name: "Scout" },
    { name: "Scout", title: "Researcher", description: "Finds things", instance_id: "claude", model: "m", effort: "high" },
  ],
  update_bot_profile: [{ bot_id: "b1", name: "New", title: "T", description: "D" }],
  list_channels: [{}],
  get_channel_messages: [{ channel_id: "g1" }],
  send_channel_message: [{ channel_id: "g1", text: "hello" }],
  create_channel: [
    { name: "Room", member_ids: ["b1"] },
    { name: "Room", member_ids: ["b1"], bulletin: "Plan", default_responder: { kind: "member", bot_id: "b1" } },
  ],
  update_channel: [{ channel_id: "g1", name: "Renamed", member_ids: ["b1"], bulletin: "Plan", default_responder: { kind: "everyone" } }],
  create_task: [{ target_type: "bot", target_id: "b1" }, { target_type: "channel", target_id: "g1", title: "Work" }],
  switch_task: [{ target_type: "bot", target_id: "b1", task_id: "t1" }, { target_type: "channel", target_id: "g1", task_id: "gt1" }],
  rename_task: [{ target_type: "bot", target_id: "b1", task_id: "t1", title: "New" }, { target_type: "channel", target_id: "g1", task_id: "gt1", title: "New" }],
  search_messages: [{ query: "hello" }, { query: "hello", task_id: "t1" }],
  wait_for_conversation: [{ target_type: "bot", target_id: "b1", timeout_seconds: 1 }],
  set_bot_model: [
    { bot_id: "b1", instance_id: "claude", model: "m" },
    { bot_id: "b1", task_id: "t1", instance_id: "claude", model: "m", effort: "high" },
  ],
  edit_bot_message: [{ bot_id: "b1", message_id: "m1", text: "edited" }, { bot_id: "b1", message_id: "m1", text: "edited", task_id: "t1" }],
  list_available_models: [{}],
  interrupt_conversation: [{ target_type: "bot", target_id: "b1" }, { target_type: "channel", target_id: "g1" }],
};

const REFUSED_ON_PURPOSE: Array<[string, Record<string, unknown>, string]> = [
  ["update_bot_profile", { bot_id: "b1", section: "Elsewhere" }, "PATCH"],
  ["update_channel", { channel_id: "g1", section: "Elsewhere" }, "PATCH"],
  ["create_bot", { name: "Scout", section: "Elsewhere" }, "POST"],
  ["create_channel", { name: "Room", member_ids: ["b1"], section: "Elsewhere" }, "POST"],
];

describe("every request the later.dog scripts make is on the allow-list", () => {
  it("covers every MCP tool, so a new tool cannot be added without deciding what the token may do", () => {
    expect(Object.keys(CALLS).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it("lets each change a tool really sends through, route and body", async () => {
    const changes: Recorded[] = [];
    for (const [tool, variants] of Object.entries(CALLS)) {
      for (const args of variants) {
        const { seen, fetcher } = recorder();
        await handleToolCall(tool, args, fetcher);
        changes.push(...seen.filter((request) => request.method !== "GET"));
      }
    }
    expect(changes.length).toBeGreaterThan(20);
    for (const change of changes) {
      expect(localToolsRouteRefusal(change.method, change.path), `${change.method} ${change.path}`).toBeNull();
      expect(localToolsBodyRefusal(change.method, change.path, change.body), `${change.method} ${change.path} ${JSON.stringify(change.body)}`).toBeNull();
    }
    const used = new Set(changes.map((change) => `${change.method} ${LOCAL_TOOLS_ALLOWED_ROUTES.findIndex((rule) => rule.methods.includes(change.method) && rule.path.test(change.path))}`));
    for (let index = 0; index < LOCAL_TOOLS_ALLOWED_ROUTES.length; index++) {
      expect([...used].some((entry) => entry.endsWith(` ${index}`)), String(LOCAL_TOOLS_ALLOWED_ROUTES[index]!.path)).toBe(true);
    }
  });

  it("refuses the one thing a tool can ask for that it may not, putting a dog or a room in a pack, or moving one", async () => {
    for (const [tool, args, method] of REFUSED_ON_PURPOSE) {
      const { seen, fetcher } = recorder();
      await handleToolCall(tool, args, fetcher);
      const change = seen.find((request) => request.method === method)!;
      expect(localToolsBodyRefusal(change.method, change.path, change.body), tool).toBe(LOCAL_TOOLS_REFUSAL);
    }
  });
});

describe("everything else is refused by default", () => {
  const refused = (method: string, path: string, body: unknown = {}) =>
    localToolsRouteRefusal(method, path) ?? localToolsBodyRefusal(method, path, body);

  it("refuses the routes a security review found a dog could use", () => {
    const holes: Array<[string, string, unknown?]> = [
      ["GET", "/api/desktop-viewer/session"], ["POST", "/api/desktop-viewer/open"], ["DELETE", "/api/desktop-viewer/x"],
      ["POST", "/api/keys/test", { url: "https://example.test" }],
      ["PUT", "/api/config", { signIn: { admins: ["me@example.test"] } }], ["PATCH", "/api/config", { newBotDefaults: {} }],
      ["PATCH", "/api/config", { features: { claudeUserMcp: true } }], ["PUT", "/api/config", { openaiCompat: { baseUrl: "https://example.test" } }],
      ["POST", "/api/bots/b1/respond", { requestId: "r", behavior: "allow" }], ["POST", "/api/threads/t1/respond", {}],
      ["PATCH", "/api/bots/b1/cards/c1", { answered: "allow" }],
      ["POST", "/api/bots/b1/takeover/c1/done"], ["POST", "/api/bots/b1/computer/control", { action: "release" }],
      ["POST", "/api/bots/b1/secret-cards/c1/provide"], ["POST", "/api/bots/b1/connector-cards/c1/resume"],
      ["POST", "/api/secure-forms/f1/submit"], ["POST", "/api/bots/b1/secure-forms/f1/submit"],
      ["POST", "/api/live/session", { botId: "b1" }], ["POST", "/api/laterdog/jobs/j1/action", { action: "merge" }],
      ["POST", "/api/bots/b1/computer/exec", { command: "id" }], ["POST", "/api/bots/b1/computer/provision"],
      ["DELETE", "/api/computers/boxes/x"], ["POST", "/api/computers/boxes/x/delete"], ["POST", "/api/team-computers"],
      ["POST", "/api/bots/b1/always-allow", { key: "Bash" }], ["POST", "/api/bots/b1/command-allowlist", {}],
      ["POST", "/api/auth/pairing"], ["POST", "/api/auth/sessions/s1"], ["DELETE", "/api/bots/b1"], ["DELETE", "/api/groups/g1"],
      ["POST", "/api/handoffs/root/continue"], ["POST", "/api/bots/b1/messages/guarded", { text: "x", threadId: "t" }],
    ];
    for (const [method, path, body] of holes) expect(refused(method, path, body), `${method} ${path}`).toBe(LOCAL_TOOLS_REFUSAL);
  });

  it("refuses an allowed route with any key the scripts do not send", () => {
    const withExtra: Array<[string, string, Record<string, unknown>]> = [
      ["POST", "/api/bots", { name: "X", settings: { approvalMode: "full", alwaysAllow: ["Bash"] } }],
      ["POST", "/api/bots", { name: "X", approvalMode: "auto" }], ["POST", "/api/bots", { name: "X", cwd: "/" }],
      ["POST", "/api/bots", { name: "X", preset: "p" }], ["POST", "/api/bots", { name: "X", computer: "local" }],
      ["POST", "/api/bots", { name: "X", section: "Ops" }], ["POST", "/api/groups", { name: "R", memberIds: ["b1"], section: "Ops" }],
      ["POST", "/api/groups", { name: "R", memberIds: ["b1"], setup: { bulletin: "", defaultResponder: { kind: "everyone" }, section: "Ops" } }],
      ["PATCH", "/api/bots/b1", { name: "X", connectorTools: { gmail: "write" } }], ["PATCH", "/api/bots/b1", { browserProfile: "p" }],
      ["PATCH", "/api/bots/b1", { cloudBackend: "vps" }], ["PATCH", "/api/bots/b1", { autoStartVps: true }],
      ["PATCH", "/api/bots/b1", { fallback: [{ instanceId: "a", model: "m" }] }], ["PATCH", "/api/bots/b1", { visibility: "everyone" }],
      ["PATCH", "/api/bots/b1", { approvalMode: "ask" }], ["PATCH", "/api/bots/b1", { autoApprove: false }], ["PATCH", "/api/bots/b1", { section: "Ops" }],
      ["PATCH", "/api/bots/b1/tasks/t1", { surface: "local" }], ["PATCH", "/api/bots/b1/tasks/t1", { approvalMode: "full" }],
      ["PATCH", "/api/bots/b1/tasks/t1", { updateBotDefault: true, modelSelection: { instanceId: "a", model: "m" } }],
      ["PATCH", "/api/groups/g1", { cwd: "/" }], ["PATCH", "/api/groups/g1", { section: "Ops" }], ["PATCH", "/api/groups/g1/tasks/t1", { cwd: "/" }],
      ["POST", "/api/groups", { name: "R", memberIds: ["b1"], cwd: "/" }], ["POST", "/api/groups", { name: "R", memberIds: ["b1"], setup: { bulletin: "", defaultResponder: { kind: "everyone" }, goal: "x" } }],
      ["POST", "/api/bots/b1/messages", { text: "x", threadId: "t1", deliver: "stop" }], ["POST", "/api/bots/b1/messages", { text: "x", answer: "allow" }],
      ["POST", "/api/bots/b1/messages", { text: "x", sendId: "s" }], ["POST", "/api/groups/g1/messages", { text: "x", mode: "goal" }],
      ["POST", "/api/bots/b1/tasks", { title: "x", approvalMode: "full" }], ["POST", "/api/bots/b1/tasks", { title: "x", projectId: "p" }],
      ["POST", "/api/bots/b1/tasks/t1", { messages: 0 }], ["POST", "/api/bots/b1/interrupt", { threadId: "t", force: true }],
      ["POST", "/api/bots/b1/messages/m1/edit", { text: "x", sendId: "s" }],
    ];
    for (const [method, path, body] of withExtra) expect(localToolsBodyRefusal(method, path, body), `${method} ${path} ${JSON.stringify(body)}`).toBe(LOCAL_TOOLS_REFUSAL);
  });

  it("refuses values of the wrong shape, nested keys it does not know, and inherited keys", () => {
    expect(localToolsBodyRefusal("POST", "/api/bots", { name: 5 })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", { name: "X", modelSelection: { instanceId: "a", model: "m", modelProvider: "p" } })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", { name: "X", modelSelection: "claude" })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", { name: "X", requireAvailableModel: "yes" })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/groups", { name: "R", memberIds: "b1" })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/groups", { name: "R", memberIds: [1] })).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", JSON.parse('{"name":"X","__proto__":{"approvalMode":"full"}}'))).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", ["name"])).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots", null)).toBe(LOCAL_TOOLS_REFUSAL);
    expect(localToolsBodyRefusal("POST", "/api/bots/b1/tasks/t1", undefined)).toBeNull();
  });

  it("says it in plain words, never calling the person the user", () => {
    expect(LOCAL_TOOLS_REFUSAL).toMatch(/approve its own work/);
    expect(LOCAL_TOOLS_REFUSAL).toMatch(/desktop app or a paired device/);
    expect(LOCAL_TOOLS_REFUSAL).not.toMatch(/\buser\b/i);
  });
});

describe("messages from local tools are never the person", () => {
  const answerer = () => ({ kind: "loopback" as const });
  it("does not count as the person being there, cannot answer a card or end a take-over, and says it came through the local API", () => {
    expect(typedMessageAuthority({ fromLocalTools: true, session: false, desktopManaged: true }, answerer)).toEqual({ personPresent: false, via: "api" });
    expect(typedMessageAuthority({ fromLocalTools: true, session: true, desktopManaged: true }, answerer)).toEqual({ personPresent: false, via: "api" });
  });
  it("leaves the desktop app and paired devices as the person", () => {
    expect(typedMessageAuthority({ fromLocalTools: false, session: false, desktopManaged: true }, answerer)).toEqual({ personPresent: true, answerer: { kind: "loopback" } });
    expect(typedMessageAuthority({ fromLocalTools: false, session: true, desktopManaged: false }, answerer)).toEqual({ personPresent: true, answerer: { kind: "loopback" } });
    expect(typedMessageAuthority({ fromLocalTools: false, session: false, desktopManaged: false }, answerer)).toMatchObject({ personPresent: false });
  });
});

function routeSamples(): string[] {
  const sources: string[] = [];
  const files = [join(process.cwd(), "server", "index.ts"), ...readdirSync(join(process.cwd(), "server", "routes"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => join(process.cwd(), "server", "routes", name))];
  const samples = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/"(\/api\/[A-Za-z0-9_\-./]+)"/g)) samples.add(match[1]!);
    for (const match of text.matchAll(/\/\^(\\\/api\\\/.+?)\$\//g)) sources.push(match[1]!);
  }
  const alternatives = (source: string): string[] => {
    let results = [source.replace(/\\\//g, "/").replace(/\\\./g, ".")];
    for (let guard = 0; guard < 12; guard++) {
      const next: string[] = [];
      let changed = false;
      for (const candidate of results) {
        const optional = /\(\?:([^()]*)\)\?/.exec(candidate);
        if (optional) { changed = true; next.push(candidate.replace(optional[0], ""), candidate.replace(optional[0], optional[1]!)); continue; }
        const alternation = /\(\??:?([^()|]+(?:\|[^()|]+)+)\)/.exec(candidate);
        if (alternation) { changed = true; for (const option of alternation[1]!.split("|")) next.push(candidate.replace(alternation[0], option)); continue; }
        const capture = /\(([^()]*)\)/.exec(candidate);
        if (capture) { changed = true; next.push(candidate.replace(capture[0], "abcdefghij0123456789")); continue; }
        next.push(candidate);
      }
      results = next;
      if (!changed) break;
    }
    return results.map((candidate) => candidate.replace(/\[[^\]]*\](?:[+*]|\{\d+(?:,\d+)?\})?/g, "abcdefghij0123456789").replace(/\?$/, ""));
  };
  for (const source of sources) for (const path of alternatives(source)) if (/^\/api\/[\w\-./]+$/.test(path)) samples.add(path);
  return [...samples];
}

describe("the server's real routes, from its own source", () => {
  const samples = routeSamples();
  const OWNER = "o".repeat(43);
  const TOOLS = "t".repeat(43);
  const gate = (method: string, path: string, token: string | undefined) => resolveRequestAuth(
    { headers: { host: "127.0.0.1:8799", ...(token ? { [LOCAL_TOOLS_HEADER]: token } : {}) }, method } as never,
    {
      sessions: { authenticate: () => null, redeemStreamTicket: () => null, renew: () => {} } as never, cookieName: "c", streamPath: "/api/events",
      url: new URL(path, "http://x"), loopbackMutationToken: OWNER, loopbackTrust: "owner", localToolsToken: TOOLS,
    },
  );

  it("finds hundreds of them, so the check below is about the real server", () => {
    expect(samples.length).toBeGreaterThan(250);
    expect(samples).toContain("/api/bots");
    expect(samples.some((path) => path.startsWith("/api/desktop-viewer/"))).toBe(true);
  });

  it("lets the token through the gate on exactly the allow-list's methods and paths, and refuses every other route and method", () => {
    const allowedHere: string[] = [];
    for (const path of samples) {
      if (path.startsWith("/api/internal/") || path === "/api/auth/pair" || path === "/api/pair" || path === "/api/testing/internal-capability") continue;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const result = gate(method, path, TOOLS);
        const onList = LOCAL_TOOLS_ALLOWED_ROUTES.some((rule) => rule.methods.includes(method) && rule.path.test(path));
        if (onList) {
          expect(result.auth, `${method} ${path}`).toEqual({ kind: "loopback", scopes: ["admin", "client"], localTools: true });
          allowedHere.push(`${method} ${path}`);
        } else {
          expect(result.auth, `${method} ${path}`).toBeNull();
          expect(result.status).toBe(403);
        }
      }
    }
    expect(allowedHere.length).toBeGreaterThanOrEqual(LOCAL_TOOLS_ALLOWED_ROUTES.length);
  });

  it("refuses the reads that return secrets, the viewer's and the connector card status, even with the token", () => {
    for (const path of samples.filter((candidate) => candidate.startsWith("/api/desktop-viewer/"))) {
      expect(gate("GET", path, TOOLS).auth, path).toBeNull();
    }
    expect(gate("GET", "/api/bots/b1/connector-cards/c1/status", TOOLS).auth).toBeNull();
  });
});
