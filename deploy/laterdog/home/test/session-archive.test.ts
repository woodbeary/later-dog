import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { archivable, createArchiver, serveArchive } from "../runtime/archive.mjs";
import { LogArchiveCoordinator, SESSION_AGE_MS, claudeSessionIds, findSessionFiles, logArchiveBridge } from "../../../../server/laterdog/log-archive.ts";
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
  expect(existsSync(join(f.root, TRANSCRIPT))).toBe(true);
  await f.coordinator().scan();
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
