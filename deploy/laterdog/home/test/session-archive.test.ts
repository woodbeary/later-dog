import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { archivable, createArchiver, serveArchive } from "../runtime/archive.mjs";
import { LogArchiveCoordinator, SESSION_AGE_MS, claudeSessionIds, findSessionFiles, logArchiveBridge, outsideSessionOwners, type CursorOwner } from "../../../../server/laterdog/log-archive.ts";
import { claudeProjectSlug, planClaudeRemote } from "../../../../server/laterdog/engine-placement.ts";
import { engineInventory } from "../../../../server/laterdog/engine-files.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const THREAD = "thread-session-1";
const OTHER = "thread-session-2";
const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECOND = "11111111-2222-4333-8444-555555555555";
const BUSY = "99999999-8888-4777-8666-555555555555";
const SLUG = "-home-dog-work";
const TRANSCRIPT = `.claude/projects/${SLUG}/${SESSION}.jsonl`;
const SUBAGENT = `.claude/projects/${SLUG}/${SESSION}/subagents/agent-a1.jsonl`;
const PROVIDER = `.laterdog/providers/claude-2/projects/${SLUG}/${SECOND}.jsonl`;
const BYTES = Buffer.from(`{"type":"user","sessionId":"${SESSION}","message":"resume me"}\n{"type":"assistant","bytes":"é\u0000ÿ"}\n`, "latin1");
const OLD = new Date(Date.now() - SESSION_AGE_MS - 60 * 60_000);

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-archive-")));
  roots.push(root);
  return root;
}
function put(root: string, path: string, bytes: Buffer | string = BYTES, when = OLD) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  utimesSync(join(root, path), when, when);
}
function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  return {
    async archiveIndex() { return structuredClone(index); },
    async putArchiveIndex(next: unknown) { index = structuredClone(next); },
    async hasArchived(hash: string) { return blobs.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) { const found = blobs.get(hash); if (!found) throw new Error("missing"); return found; },
  };
}
async function fixture(root = scratch()) {
  const store = memory();
  const archiver = createArchiver({ root, store });
  const service = await serveArchive(archiver, { token: "session-archive-fixture" });
  cleanups.push(service.close);
  const bridge = logArchiveBridge(service.url, "session-archive-fixture");
  const busy = new Set<string>();
  const cursors: Record<string, Record<string, unknown>> = {
    [THREAD]: { claude: SESSION, "claude-2": SECOND, codex: "not-a-claude-session" },
    [OTHER]: { claude: BUSY },
  };
  const reports: string[] = [];
  const coordinator = (extra: Partial<ConstructorParameters<typeof LogArchiveCoordinator>[0]> = {}) => new LogArchiveCoordinator({
    root, bridge, threads: () => [THREAD, OTHER], idle: id => !busy.has(id), retryMs: 5,
    sessions: id => claudeSessionIds(cursors[id]), report: message => reports.push(message), ...extra,
  });
  return { root, store, archiver, service, bridge, busy, cursors, reports, coordinator };
}

it("reads Claude session ids only from exact cursor shapes", () => {
  expect(claudeSessionIds({ claude: SESSION, legacy: { sessionId: SECOND }, codex: "thread-xyz", bad: "../" + SESSION, none: null })).toEqual([SESSION, SECOND]);
  expect(claudeSessionIds(undefined)).toEqual([]);
});

it("archives idle known threads' exact session files after 72 hours and nothing else", async () => {
  const f = await fixture();
  put(f.root, TRANSCRIPT);
  put(f.root, SUBAGENT, "subagent transcript\n");
  put(f.root, PROVIDER, "provider session\n");
  put(f.root, `.claude/projects/${SLUG}/${BUSY}.jsonl`, "busy shared session\n");
  put(f.root, `.claude/projects/${SLUG}/22222222-3333-4444-8555-666666666666.jsonl`, "unknown thread\n");
  put(f.root, ".claude.json", "{}");
  put(f.root, ".claude/.credentials.json", "{\"claudeAiOauth\":{}}");
  put(f.root, ".laterdog/providers/claude-2/.claude.json", "{}");
  put(f.root, ".laterdog/providers/claude-2/.credentials.json", "{}");
  put(f.root, `.claude/file-history/${SESSION}/edit`, "history\n");
  f.cursors[OTHER] = { claude: BUSY };
  f.busy.add(OTHER);
  f.cursors[THREAD] = { ...f.cursors[THREAD], shared: BUSY };
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(false);
  expect(existsSync(join(f.root, SUBAGENT))).toBe(false);
  expect(existsSync(join(f.root, PROVIDER))).toBe(false);
  for (const kept of [`.claude/projects/${SLUG}/${BUSY}.jsonl`, `.claude/projects/${SLUG}/22222222-3333-4444-8555-666666666666.jsonl`, ".claude.json",
    ".claude/.credentials.json", ".laterdog/providers/claude-2/.claude.json", ".laterdog/providers/claude-2/.credentials.json", `.claude/file-history/${SESSION}/edit`]) {
    expect(existsSync(join(f.root, kept)), kept).toBe(true);
  }
  expect((await (await fetch(new URL("status", f.service.url), { headers: { authorization: "Bearer session-archive-fixture" } })).json()).sessions)
    .toEqual({ files: 3, bytes: BYTES.length + "subagent transcript\n".length + "provider session\n".length });
});

it("reports session files and bytes separately from logs", async () => {
  const f = await fixture();
  put(f.root, TRANSCRIPT);
  put(f.root, `.laterdog/events/${THREAD}.ndjson`, "event log\n");
  const coordinator = f.coordinator();
  await coordinator.scan();
  expect(coordinator.status()).toMatchObject({ enabled: true, archivedFiles: 1, archivedBytes: "event log\n".length, sessionFiles: 1, sessionBytes: BYTES.length });
  expect(f.reports.join(" ")).toMatch(/archived 1 logs .* and 1 engine session files/);
});

it("keeps sessions that are recent, belong to busy threads, or contain anything outside the exact shape", async () => {
  const f = await fixture();
  put(f.root, TRANSCRIPT, BYTES, new Date(Date.now() - SESSION_AGE_MS + 60 * 60_000));
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  utimesSync(join(f.root, TRANSCRIPT), OLD, OLD);
  f.busy.add(THREAD);
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  f.busy.clear();
  put(f.root, SUBAGENT, "subagent\n", new Date());
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  utimesSync(join(f.root, SUBAGENT), OLD, OLD);
  put(f.root, `.claude/projects/${SLUG}/${SESSION}/credentials.json`, "{}");
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  rmSync(join(f.root, `.claude/projects/${SLUG}/${SESSION}/credentials.json`));
  put(f.root, "outside.txt", "outside the session\n");
  symlinkSync(join(f.root, "outside.txt"), join(f.root, `.claude/projects/${SLUG}/${SESSION}/link.txt`));
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  expect(existsSync(join(f.root, "outside.txt"))).toBe(true);
  rmSync(join(f.root, `.claude/projects/${SLUG}/${SESSION}/link.txt`));
  put(f.root, `.claude/projects/${SLUG}/${SESSION}/a/b/c/deep.txt`, "too deep\n");
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  rmSync(join(f.root, `.claude/projects/${SLUG}/${SESSION}/a`), { recursive: true });
  await f.coordinator({ sessionByteLimit: 1 }).scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(false);
  expect(existsSync(join(f.root, SUBAGENT))).toBe(false);
});

it("never follows a symlinked transcript, project folder or config folder", async () => {
  const f = await fixture();
  put(f.root, "elsewhere/session.jsonl");
  mkdirSync(join(f.root, `.claude/projects/${SLUG}`), { recursive: true });
  symlinkSync(join(f.root, "elsewhere/session.jsonl"), join(f.root, TRANSCRIPT));
  put(f.root, `elsewhere/projects/${SLUG}/${SECOND}.jsonl`);
  mkdirSync(join(f.root, ".laterdog/providers"), { recursive: true });
  symlinkSync(join(f.root, "elsewhere"), join(f.root, ".laterdog/providers/claude-2"));
  put(f.root, `real/${BUSY}.jsonl`);
  symlinkSync(join(f.root, "real"), join(f.root, ".claude/projects/-linked"));
  const found = await findSessionFiles(f.root, new Set([SESSION, SECOND, BUSY]));
  expect(found.get(SESSION)?.unsafe).toBe(true);
  expect(found.has(SECOND)).toBe(false);
  expect(found.has(BUSY)).toBe(false);
  f.cursors[THREAD] = { claude: SESSION, other: SECOND, third: BUSY };
  await f.coordinator().scan();
  expect(readFileSync(join(f.root, "elsewhere/session.jsonl"))).toEqual(BYTES);
  expect(existsSync(join(f.root, `elsewhere/projects/${SLUG}/${SECOND}.jsonl`))).toBe(true);
  expect(existsSync(join(f.root, `real/${BUSY}.jsonl`))).toBe(true);
});

it("the root archive admits only exact session shapes and refuses credentials, traversal and symlinks", async () => {
  for (const path of [TRANSCRIPT, SUBAGENT, PROVIDER, `.claude/projects/${SLUG}/${SESSION}/tool-results/out.txt`]) expect(archivable(path), path).toBe(true);
  for (const path of [".claude.json", ".claude/.credentials.json", ".laterdog/providers/claude-2/.claude.json", ".laterdog/providers/claude-2/.credentials.json",
    `.claude/projects/${SLUG}/not-a-session.jsonl`, `.claude/projects/${SLUG}/${SESSION}/credentials.json`, `.claude/projects/${SLUG}/${SESSION}/../x.jsonl`,
    `.claude/projects/${SLUG}/../${SESSION}.jsonl`, `.claude/projects/${SLUG}/${SESSION}/.laterdog-restoring-x`, `.claude/projects/${SLUG}/${SESSION}/a/b/c/d`,
    `/.claude/projects/${SLUG}/${SESSION}.jsonl`, `.claude/projects/../.credentials.json`, `.claude/file-history/${SESSION}/x`,
    `.laterdog/providers/claude-2/projects/${SLUG}/${SESSION}.json`, `.laterdog/providers/../projects/${SLUG}/${SESSION}.jsonl`,
    `.laterdog/providers/claude-2/auth.json`, `.claude/projects/${SLUG}/${SESSION.toUpperCase()}.jsonl`]) expect(archivable(path), path).toBe(false);
  const f = await fixture();
  put(f.root, "outside.jsonl");
  mkdirSync(join(f.root, `.claude/projects/${SLUG}`), { recursive: true });
  symlinkSync(join(f.root, "outside.jsonl"), join(f.root, TRANSCRIPT));
  expect(await f.archiver.archive([TRANSCRIPT, ".claude/.credentials.json"])).toMatchObject({ archived: 0 });
  expect(readFileSync(join(f.root, "outside.jsonl"))).toEqual(BYTES);
  const post = (route: string, body: unknown) => fetch(new URL(route, f.service.url), { method: "POST",
    headers: { authorization: "Bearer session-archive-fixture", "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("restore-sessions", { sessions: ["../etc"] })).status).toBe(400);
  expect((await post("restore-sessions", { sessions: [`${SESSION}.jsonl`] })).status).toBe(400);
  expect((await post("restore-logs", { paths: [TRANSCRIPT] })).status).toBe(400);
  expect((await fetch(new URL("restore-sessions", f.service.url), { method: "POST", body: JSON.stringify({ sessions: [SESSION] }) })).status).toBe(401);
});

it("restores exact session bytes before the turn proceeds, then refuses to clobber a newer local copy", async () => {
  const f = await fixture();
  put(f.root, TRANSCRIPT);
  put(f.root, SUBAGENT, "subagent transcript\n");
  await f.coordinator().scan();
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(false);
  f.busy.add(THREAD);
  expect(await f.coordinator().beforeTurn(THREAD, () => true)).toBe(true);
  expect(readFileSync(join(f.root, TRANSCRIPT))).toEqual(BYTES);
  expect(readFileSync(join(f.root, SUBAGENT), "utf8")).toBe("subagent transcript\n");
  writeFileSync(join(f.root, TRANSCRIPT), "newer local turn\n");
  expect(await f.coordinator().beforeTurn(THREAD, () => true)).toBe(true);
  expect(readFileSync(join(f.root, TRANSCRIPT), "utf8")).toBe("newer local turn\n");
});

it("keeps a pending turn through a session restore outage and retries until the bytes return", async () => {
  const f = await fixture();
  put(f.root, TRANSCRIPT);
  await f.coordinator().scan();
  f.busy.add(THREAD);
  const fetchBlob = f.store.getArchived;
  let attempts = 0;
  f.store.getArchived = async hash => {
    attempts++;
    if (attempts <= 3) {
      expect(existsSync(join(f.root, TRANSCRIPT))).toBe(false);
      throw new Error("isolated storage outage");
    }
    return fetchBlob(hash);
  };
  let dispatched = false;
  const ready = await f.coordinator().beforeTurn(THREAD, () => !dispatched);
  expect(ready).toBe(true);
  dispatched = true;
  expect(attempts).toBe(4);
  expect(readFileSync(join(f.root, TRANSCRIPT))).toEqual(BYTES);
  expect(f.reports.filter(report => report.startsWith("saved"))).toEqual(["saved logs unavailable; keeping the pending turn and retrying"]);
  rmSync(join(f.root, TRANSCRIPT));
  f.store.getArchived = async () => { throw new Error("offline"); };
  let current = true;
  setTimeout(() => { current = false; }, 30);
  expect(await f.coordinator().beforeTurn(THREAD, () => current)).toBe(false);
});

it("restores the session before remote placement inventories the files it pushes", async () => {
  const root = scratch();
  const f = await fixture(root);
  const work = join(root, "work");
  const config = join(root, ".claude");
  const pkg = join(root, "lib", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.316" }));
  writeFileSync(join(pkg, "bin", "claude"), "");
  const slug = claudeProjectSlug(work);
  const transcript = `.claude/projects/${slug}/${SESSION}.jsonl`;
  const extra = `.claude/projects/${slug}/${SESSION}/subagents/agent-a1.jsonl`;
  put(root, transcript);
  put(root, extra, "subagent transcript\n");
  f.cursors[THREAD] = { claude: SESSION };
  await f.coordinator().scan();
  expect(existsSync(join(root, transcript))).toBe(false);
  const plan = () => {
    const planned = planClaudeRemote({ botId: "bot", threadId: THREAD, sessionId: SESSION, cliCommand: join(pkg, "bin", "claude"), args: ["-p", "--resume", SESSION],
      cwd: work, env: { HOME: root, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin", ANTHROPIC_API_KEY: "fixture" }, managed: false,
      dataDir: join(root, ".laterdog"), proxyPath: "/home/dog/.laterdog-engine/relay/x/engine-proxy.js" });
    if (!("plan" in planned)) throw new Error(planned.stay);
    return engineInventory(planned.plan.launch.roots.filter(entry => entry.id === "session" || entry.id === "session-extra"));
  };
  expect(plan()).toEqual([]);
  f.busy.add(THREAD);
  expect(await f.coordinator().beforeTurn(THREAD, () => true)).toBe(true);
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  expect(plan().map(({ root: id, path, hash }) => ({ id, path, hash })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: "session", path: `${SESSION}.jsonl`, hash: sha(BYTES) },
    { id: "session-extra", path: "subagents/agent-a1.jsonl", hash: sha("subagent transcript\n") },
  ]);
});

const ORPHAN = "33333333-4444-4555-8666-777777777777";
const LATER = "55555555-6666-4777-8888-999999999999";
const YOUNG = "44444444-5555-4666-8777-888888888888";
const GROUPED = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const LOCKED = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const LINKED = "88888888-9999-4aaa-8bbb-cccccccccccc";
const GROUP_THREAD = "thread-group-chat";
const transcriptOf = (id: string) => `.claude/projects/${SLUG}/${id}.jsonl`;
const subagentOf = (id: string) => `.claude/projects/${SLUG}/${id}/subagents/agent-a1.jsonl`;
const cursorsOf = (ids: string[]) => Object.fromEntries(ids.map((id, at) => [`claude-${at}`, id]));
function ownership(bots: () => CursorOwner[]) {
  return { outsideSessions: () => outsideSessionOwners(bots(), thread => thread === GROUP_THREAD) };
}
function owners(f: Awaited<ReturnType<typeof fixture>>, group: string[] = []) {
  return ownership(() => [{ threadId: THREAD, resumeCursors: f.cursors[THREAD],
    tasks: [...[THREAD, OTHER].map(threadId => ({ threadId, resumeCursors: f.cursors[threadId] })), { threadId: GROUP_THREAD, resumeCursors: cursorsOf(group) }] }]);
}
function paused(bridge: ReturnType<typeof logArchiveBridge>) {
  const events: string[] = [];
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  let first = true;
  const wrapped: typeof bridge = {
    async archive(paths) {
      if (first) { first = false; events.push("archive held"); reached(); await hold; }
      const result = await bridge.archive(paths);
      events.push(`archived ${paths.length}`);
      return result;
    },
    restore: paths => bridge.restore(paths),
    async restoreSessions(sessions) { events.push(`restore ${sessions.join(",")}`); await bridge.restoreSessions(sessions); },
  };
  return { bridge: wrapped, events, release, arrived };
}

it("archives an untracked session after 72 hours only when ownership is known and no guard holds it", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(ORPHAN));
  put(f.root, subagentOf(ORPHAN), "orphan subagent\n");
  put(f.root, transcriptOf(YOUNG), "young\n", new Date());
  put(f.root, transcriptOf(GROUPED), "group chat session\n");
  put(f.root, transcriptOf(LOCKED), "protected\n");
  put(f.root, `.claude/projects/${SLUG}/${LOCKED}/credentials.json`, "{}");
  put(f.root, "elsewhere.jsonl", "outside\n");
  symlinkSync(join(f.root, "elsewhere.jsonl"), join(f.root, transcriptOf(LINKED)));
  put(f.root, transcriptOf(BUSY), "busy shared session\n");
  f.busy.add(OTHER);
  await f.coordinator().scan();
  expect(existsSync(join(f.root, transcriptOf(ORPHAN)))).toBe(true);
  await f.coordinator(owners(f, [GROUPED])).scan();
  expect(existsSync(join(f.root, transcriptOf(ORPHAN)))).toBe(false);
  expect(existsSync(join(f.root, subagentOf(ORPHAN)))).toBe(false);
  for (const kept of [transcriptOf(YOUNG), transcriptOf(GROUPED), transcriptOf(LOCKED), `.claude/projects/${SLUG}/${LOCKED}/credentials.json`, transcriptOf(BUSY), "elsewhere.jsonl"]) {
    expect(existsSync(join(f.root, kept)), kept).toBe(true);
  }
  expect(readFileSync(join(f.root, transcriptOf(LINKED)), "utf8")).toBe("outside\n");
});

it("keeps a session an idle thread shares with a group chat or another dog's own cursor, and archives a bot's mirror of its active task", async () => {
  const f = await fixture();
  const withGroup = "a1111111-1111-4111-8111-111111111111";
  const withOtherDog = "a2222222-2222-4222-8222-222222222222";
  const groupOnly = "a3333333-3333-4333-8333-333333333333";
  const otherDogOnly = "a4444444-4444-4444-8444-444444444444";
  const mirrored = "a5555555-5555-4555-8555-555555555555";
  const otherActive = "a6666666-6666-4666-8666-666666666666";
  for (const id of [withGroup, withOtherDog, groupOnly, otherDogOnly, mirrored]) put(f.root, transcriptOf(id), `${id}\n`);
  f.cursors[THREAD] = cursorsOf([withGroup, withOtherDog, mirrored]);
  const coordinator = f.coordinator(ownership(() => [
    { threadId: THREAD, resumeCursors: { claude: mirrored }, tasks: [{ threadId: THREAD, resumeCursors: f.cursors[THREAD] }, { threadId: OTHER, resumeCursors: f.cursors[OTHER] },
      { threadId: GROUP_THREAD, resumeCursors: cursorsOf([withGroup, groupOnly]) }] },
    { threadId: "thread-second-dog", resumeCursors: cursorsOf([withOtherDog, otherDogOnly]), tasks: [{ threadId: "thread-second-dog", resumeCursors: { claude: otherActive } }] },
  ]));
  await coordinator.scan();
  await coordinator.scan();
  expect(existsSync(join(f.root, transcriptOf(mirrored)))).toBe(false);
  for (const id of [withGroup, withOtherDog, groupOnly, otherDogOnly]) expect(readFileSync(join(f.root, transcriptOf(id)), "utf8"), id).toBe(`${id}\n`);
});

it("rechecks ownership that appears while the archive waits for the session lock", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(LATER), "shared later\n");
  f.cursors[THREAD] = { claude: LATER };
  f.cursors[OTHER] = { claude: LATER };
  const group: string[] = [];
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  const archived: string[][] = [];
  const bridge = { ...f.bridge,
    archive: (paths: string[]) => { archived.push(paths); return f.bridge.archive(paths); },
    async restoreSessions(sessions: string[]) { reached(); await hold; await f.bridge.restoreSessions(sessions); } };
  const coordinator = f.coordinator({ bridge, ...owners(f, group) });
  const turn = coordinator.beforeTurn(OTHER, () => true);
  await arrived;
  const scan = coordinator.scan();
  await new Promise(resolve => setTimeout(resolve, 50));
  group.push(LATER);
  f.cursors[OTHER] = { claude: BUSY };
  release();
  expect(await turn).toBe(true);
  await scan;
  expect(archived).toEqual([]);
  expect(readFileSync(join(f.root, transcriptOf(LATER)), "utf8")).toBe("shared later\n");
});

it("a later resume of a once-untracked session restores every file before the turn proceeds", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(ORPHAN));
  put(f.root, subagentOf(ORPHAN), "orphan subagent\n");
  await f.coordinator(owners(f)).scan();
  expect(existsSync(join(f.root, transcriptOf(ORPHAN)))).toBe(false);
  f.cursors[THREAD] = { claude: ORPHAN };
  f.busy.add(THREAD);
  expect(await f.coordinator(owners(f)).beforeTurn(THREAD, () => true)).toBe(true);
  expect(readFileSync(join(f.root, transcriptOf(ORPHAN)))).toEqual(BYTES);
  expect(readFileSync(join(f.root, subagentOf(ORPHAN)), "utf8")).toBe("orphan subagent\n");
  f.store.getArchived = async () => { throw new Error("offline"); };
  rmSync(join(f.root, transcriptOf(ORPHAN)));
  rmSync(join(f.root, subagentOf(ORPHAN)));
  let current = true;
  setTimeout(() => { current = false; }, 30);
  expect(await f.coordinator(owners(f)).beforeTurn(THREAD, () => current)).toBe(false);
  expect(existsSync(join(f.root, transcriptOf(ORPHAN)))).toBe(false);
});

it("when the archive wins the session lock, a turn that resumes that session waits and restores it before proceeding", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(ORPHAN));
  const p = paused(f.bridge);
  const coordinator = f.coordinator({ bridge: p.bridge, ...owners(f) });
  const scan = coordinator.scan();
  await p.arrived;
  f.cursors[THREAD] = { claude: ORPHAN };
  f.busy.add(THREAD);
  let ready = false;
  const turn = coordinator.beforeTurn(THREAD, () => true).then(value => { ready = value; p.events.push("turn ready"); });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ready).toBe(false);
  p.release();
  await Promise.all([scan, turn]);
  expect(p.events).toEqual(["archive held", "archived 1", `restore ${ORPHAN}`, "turn ready"]);
  expect(readFileSync(join(f.root, transcriptOf(ORPHAN)))).toEqual(BYTES);
});

it("rechecks ownership under the session lock, so a session resumed after discovery is kept", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(ORPHAN));
  put(f.root, transcriptOf(LATER), "resumed after the sweep listed it\n");
  const p = paused(f.bridge);
  const coordinator = f.coordinator({ bridge: p.bridge, ...owners(f) });
  const scan = coordinator.scan();
  await p.arrived;
  f.cursors[THREAD] = { claude: LATER };
  f.busy.add(THREAD);
  expect(await coordinator.beforeTurn(THREAD, () => true)).toBe(true);
  p.release();
  await scan;
  expect(existsSync(join(f.root, transcriptOf(ORPHAN)))).toBe(false);
  expect(readFileSync(join(f.root, transcriptOf(LATER)), "utf8")).toBe("resumed after the sweep listed it\n");
  await coordinator.scan();
  expect(existsSync(join(f.root, transcriptOf(LATER)))).toBe(true);
});

it("two turns sharing sessions in opposite order and a sweep all finish without deadlock", async () => {
  const f = await fixture();
  put(f.root, transcriptOf(ORPHAN));
  put(f.root, transcriptOf(LATER), "later\n");
  const coordinator = f.coordinator(owners(f));
  await coordinator.scan();
  f.cursors[THREAD] = { a: ORPHAN, b: LATER };
  f.cursors[OTHER] = { a: LATER, b: ORPHAN };
  f.busy.add(THREAD);
  f.busy.add(OTHER);
  const all = Promise.all([coordinator.beforeTurn(THREAD, () => true), coordinator.beforeTurn(OTHER, () => true), coordinator.scan()]);
  const outcome = await Promise.race([all.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("stuck"), 5000))]);
  expect(outcome).toBe("done");
  expect(readFileSync(join(f.root, transcriptOf(ORPHAN)))).toEqual(BYTES);
  expect(readFileSync(join(f.root, transcriptOf(LATER)), "utf8")).toBe("later\n");
});

it("a session larger than the sweep budget goes first in the next sweep, then other sessions follow", async () => {
  const f = await fixture();
  const small = "11111111-1111-4111-8111-111111111111";
  const big = "55555555-5555-4555-8555-555555555555";
  const last = "77777777-7777-4777-8777-777777777777";
  put(f.root, transcriptOf(small), "12345");
  put(f.root, transcriptOf(big), "x".repeat(100));
  put(f.root, transcriptOf(last), "67890");
  const calls: string[][] = [];
  const bridge = { ...f.bridge, archive: (paths: string[]) => { calls.push(paths); return f.bridge.archive(paths); } };
  const coordinator = f.coordinator({ bridge, sessionByteLimit: 8, ...owners(f) });
  await coordinator.scan();
  expect(calls).toEqual([[transcriptOf(small)]]);
  await coordinator.scan();
  expect(calls.slice(1)).toEqual([[transcriptOf(big)]]);
  expect(existsSync(join(f.root, transcriptOf(last)))).toBe(true);
  await coordinator.scan();
  expect(calls.slice(2)).toEqual([[transcriptOf(last)]]);
  for (const id of [small, big, last]) expect(existsSync(join(f.root, transcriptOf(id))), id).toBe(false);
  f.cursors[THREAD] = { claude: big };
  f.busy.add(THREAD);
  expect(await coordinator.beforeTurn(THREAD, () => true)).toBe(true);
  expect(readFileSync(join(f.root, transcriptOf(big)), "utf8")).toBe("x".repeat(100));
});

it("keeps a session past a thread's 200-session restore cap, busy or idle", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 201 }, (_, at) => `b${String(at).padStart(7, "0")}-0000-4000-8000-000000000000`);
  const beyond = ids[200];
  put(f.root, transcriptOf(beyond), "past the cap\n");
  f.cursors[THREAD] = cursorsOf(ids);
  f.busy.add(THREAD);
  await f.coordinator(owners(f)).scan();
  expect(readFileSync(join(f.root, transcriptOf(beyond)), "utf8")).toBe("past the cap\n");
  f.busy.delete(THREAD);
  await f.coordinator(owners(f)).scan();
  expect(readFileSync(join(f.root, transcriptOf(beyond)), "utf8")).toBe("past the cap\n");
});
