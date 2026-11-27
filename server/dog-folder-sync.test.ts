import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const touched: Array<{ call: string; path: string }> = [];
const roots: string[] = [];

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const watched = Object.fromEntries(Object.entries(real).map(([name, value]) => {
    if (!name.endsWith("Sync") || typeof value !== "function") return [name, value];
    const wrapped = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && roots.some((root) => first === root || first.startsWith(`${root}/`))) touched.push({ call: name, path: first });
      return (value as (...inner: unknown[]) => unknown)(...args);
    };
    return [name, wrapped];
  }));
  return { ...watched, default: { ...real, ...watched } };
});

const workspace = await import("./workspace.ts");
const journal = await import("./memory-journal.ts");
const store = await import("./memory-store.ts");
const recall = await import("./recall.ts");
const backup = await import("./team-backup.ts");
const { createBotMemoryRoutes } = await import("./routes/bot-memory.ts");
const { dispatchRoutes } = await import("./routes/table.ts");
const { json, readBody } = await import("./harness/http.ts");
const placement = await import("./laterdog/engine-placement.ts");
const codex = await import("./laterdog/codex-placement.ts");
const claudeProject = await import("./laterdog/claude-project.ts");
const { permissionLaunchCwd } = await import("./drivers/permission-command.ts");
const { guardMountedFolders } = await import("./laterdog/dog-mounts.ts");
const { DATA_DIR } = await import("./config.ts");
const { join } = await import("node:path");
const { skillsCall, skillsPromptReady } = await import("./skills-thread.ts");

const bot = `dog-folder-sync-${process.pid}`;
let server: Server;
let base = "";

beforeAll(async () => {
  await workspace.writeMemoryFile(bot, "# Memory\n- The person likes green tea\n");
  await workspace.writeMemoryTopic(bot, "places.md", "---\ntitle: Places\ndescription: cities the person visits\n---\n- Berlin in spring\n");
  await workspace.writeMemoryLog(bot, "2026-11-27.md", "- 01:00 · met the person\n");
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  const project = join(DATA_DIR, "..", `project-${process.pid}`);
  (await vi.importActual<typeof import("node:fs")>("node:fs")).mkdirSync(project, { recursive: true });
  guardMountedFolders([workspace.WORKSPACES_DIR, project]);
  roots.push(workspace.WORKSPACES_DIR, workspace.TASK_WORKSPACES_DIR, project);
  const routes = [createBotMemoryRoutes({
    bot: (id) => (id === bot ? { id, memoryUpkeep: false } : undefined), taskByThread: () => undefined,
    upkeep: { status: () => ({ modelSteps: false }), tidy: async () => ({}) as never },
    aboutMe: () => "", saveAboutMe: () => {},
  })];
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "remote", scopes: ["admin"] } as never, json, readBody })) json(res, 404, {});
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  const project = roots[2];
  roots.length = 0;
  vi.unstubAllEnvs();
  guardMountedFolders([]);
  if (project) (await vi.importActual<typeof import("node:fs")>("node:fs")).rmSync(project, { recursive: true, force: true });
  const { rmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
  rmSync(workspace.workspaceDir(bot), { recursive: true, force: true });
  rmSync(workspace.taskWorkspacePath(bot, "launch"), { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe("server code that reads or writes a dog's mounted folder", () => {
  it("never calls a synchronous file-system function on the folder", async () => {
    const overview = await call("GET", `/api/bots/${bot}/memory`);
    expect(overview.status).toBe(200);
    expect(overview.body.text).toContain("green tea");
    expect((await call("GET", `/api/bots/${bot}/memory/file?path=memory/places.md`)).body.text).toContain("Berlin");
    expect((await call("PUT", `/api/bots/${bot}/memory`, { text: "# Memory\n- The person likes oolong\n" })).status).toBe(200);
    const saved = await call("PUT", `/api/bots/${bot}/memory/file`, { path: "memory/people.md", text: "- Sam\n" });
    expect(saved.status).toBe(200);
    expect((await call("DELETE", `/api/bots/${bot}/memory/file?path=memory/people.md`)).status).toBe(200);
    expect((await call("GET", `/api/bots/${bot}/memory/journal`)).status).toBe(200);

    expect(await journal.beginMemoryTurnInBackground(bot, "turn-1")).not.toBeNull();
    await journal.endMemoryTurnInBackground("turn-1");
    const prompt = await workspace.readMemoryFiles(bot, () => workspace.memorySystemPrompt(bot, { managedWrites: true, fileTools: true }));
    expect(prompt).toContain("oolong");
    expect(prompt).toContain("places.md");
    expect(await workspace.readMemoryFiles(bot, () => workspace.memoryTrimmed(bot))).toBe(false);
    expect(await workspace.readMemoryFiles(bot, () => workspace.searchMemoryFiles(bot, "Berlin"))).not.toEqual([]);
    expect(await workspace.readMemoryFiles(bot, () => workspace.readRecallMemoryFile(bot, "memory/places.md"))).toContain("Berlin");
    expect(await workspace.readMemoryFiles(bot, () => recall.buildRecall({ botId: bot, message: "what about Berlin places again", threadIds: [], label: () => "", author: () => "" }))).not.toBeNull();
    const team = await backup.createTeamBackup({ bots: [{ id: bot, name: "Sync", title: "", description: "", color: "green", threadId: "t", createdAt: 0 }], groups: [], activeLeaf: () => null, messagesFor: () => [] } as never, [], "Team");
    expect(team.bots[0]!.memory?.topics.map((topic) => topic.name)).toContain("places.md");
    expect((await store.memoryOverview(bot)).logs).toHaveLength(1);
    await workspace.appendMemoryLogInBackground(bot, "a later note");

    expect(touched).toEqual([]);
  });

  it("launches an engine on a dog or project folder without a synchronous call on it", async () => {
    const dog = workspace.workspaceDir(bot);
    const project = roots[2]!;
    const task = await workspace.ensureTaskWorkspaceReady(bot, "launch");
    expect(await placement.botFolderPresent(DATA_DIR, bot)).toBe(true);
    expect(placement.botFolderRoot(DATA_DIR, bot, task, "/config", "/staging", true)?.path).toBe(dog);
    for (const cwd of [dog, task, project]) {
      const resolved = permissionLaunchCwd(cwd);
      expect(resolved()).toBe(cwd);
      await new Promise((settle) => setTimeout(settle, 20));
      expect(resolved()).toBeTruthy();
      expect(claudeProject.physicalClaudePath(cwd)).toBe(cwd);
      expect(claudeProject.claudeSessionWorkspace(cwd, "/no-config", "11111111-2222-3333-4444-555555555555").physical).toBe(cwd);
    }
    expect(await codex.codexComputerWorkspace(DATA_DIR, bot, "launch", task)).toBe(true);
    expect(touched).toEqual([]);
  });

  it("lists, installs and indexes a dog's skills for its turn without a synchronous call on the main thread", async () => {
    const skill = "---\nname: tea-notes\ndescription: Notes on tea.\n---\n\nSteep it.\n";
    expect(await skillsCall(bot, "installSkill", bot, "src", [{ path: "SKILL.md", content: skill }])).toMatchObject({ name: "tea-notes" });
    expect(await skillsCall(bot, "setSkillEnabled", bot, "tea-notes", true)).toMatchObject({ enabled: true });
    expect(await skillsPromptReady(bot)).toContain("tea-notes");
    expect((await skillsCall(bot, "listSkills", bot)).map((entry) => entry.name)).toEqual(["tea-notes"]);
    expect(await skillsCall(bot, "readSkillFile", bot, "tea-notes")).toBe(skill);
    expect(await skillsCall(bot, "removeSkill", bot, "tea-notes")).toEqual({ removed: true });
    expect(touched).toEqual([]);
  });

  it("refuses a synchronous read of the folder without a snapshot", () => {
    expect(() => workspace.loadMemory(bot)).toThrow(/not answering/);
    expect(() => workspace.memoryTopicIndex(bot)).toThrow(/not answering/);
    expect(touched).toEqual([]);
  });
});

describe("the repo-wide tripwire for mounted folders", () => {
  it("catches server code that makes a synchronous call on a mounted dog folder, and names the allowed desktop branch", async () => {
    const { onMountedSyncCall, SYNC_CALLS_ALLOWED } = await import("./laterdog/sync-tripwire.ts");
    const skillsModule = await import("./skills.ts");
    const caught: string[] = [];
    const previous = onMountedSyncCall((hit) => { caught.push(hit.call); });
    vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
    vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
    try {
      await workspace.ensureWorkspaceReady(bot);
      skillsModule.syncSkillLinks(bot);
    } finally {
      onMountedSyncCall(previous);
    }
    expect(caught.length).toBeGreaterThan(0);
    expect(SYNC_CALLS_ALLOWED.map((entry) => entry.frame)).toEqual(["dogTricks"]);
  });
});
