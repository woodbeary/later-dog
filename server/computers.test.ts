// The facade the server uses for a dog's cloud computer, against a local stub that plays later.dog's computers service
// (/v1) and Boat (/api/box/v1). It must leave Boat untouched until later.dog's computers are chosen, then keep every
// shape and decision index.ts relies on.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type State = "starting" | "running" | "sleeping" | "stopping" | "error";
type FakeComputer = { id: string; name: string; state: State };
type Recorded = { method: string; path: string; headers: IncomingMessage["headers"]; body: string };

const KEY = `ldc_${"f".repeat(48)}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const noBoat = {} as any;
const withBoat = { box: { token: "box_test" } } as any;
const owner = (botId: string, name = botId, inUse = false) => ({ botId, name, inUse });

describe("the cloud computer facade", () => {
  let api: Server;
  let port = 0;
  let keyDir = "";
  let environmentId = "";
  let computers: typeof import("./computers.ts");
  let boat: typeof import("./boat.ts");
  const fleet = new Map<string, FakeComputer>();
  // What each idempotency key first made, kept after deletion: a replayed key answers with it.
  const keys = new Map<string, FakeComputer>();
  const requests: Recorded[] = [];
  const failures = new Map<string, { status: number; error?: { code?: string; message?: string } }>();
  let nextId = 1;
  let wakeTo: State = "running";
  let startsOnPoll = false;
  let dropCreateAnswer = false;
  let concurrentCreate: string | null = null;
  let frame = JPEG;

  const nameFor = (botId: string) => `dog-${sha256(environmentId).slice(0, 12)}-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot"}-${sha256(botId).slice(0, 6)}`;
  const keyFor = (botId: string, replacing = "") => `ldc-create-${sha256(`${environmentId}\0${botId}\0${replacing}`).slice(0, 40)}`;
  const ours = () => requests.filter((request) => request.path.startsWith("/v1/"));
  const creates = () => ours().filter((request) => request.method === "POST" && request.path === "/v1/computers");
  const add = (botId: string, state: State, name = nameFor(botId)) => {
    const computer = { id: `cmp_${nextId++}`, name, state };
    fleet.set(computer.id, computer);
    return computer;
  };

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const method = req.method ?? "GET";
        requests.push({ method, path: url.pathname, headers: req.headers, body });
        const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value)); };
        if (url.pathname.startsWith("/api/box/v1/")) {
          if (url.pathname === "/api/box/v1/boxes" && method === "GET") return send(200, { ok: true, boxes: [] });
          if (url.pathname.endsWith("/commands")) return send(200, { ok: true, exitCode: 0, stdout: "boat", stderr: "" });
          return send(404, { ok: false, message: "not found" });
        }
        if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { code: "unauthorized", message: "unknown key" } });
        const failure = failures.get(`${method} ${url.pathname}`);
        if (failure) {
          failures.delete(`${method} ${url.pathname}`);
          return send(failure.status, { error: failure.error ?? {} });
        }
        const [, id, action] = /^\/v1\/computers(?:\/(cmp_[\w-]+)(?:\/(\w+))?)?$/.exec(url.pathname) ?? [];
        if (url.pathname === "/v1/computers" && method === "GET") return send(200, { computers: [...fleet.values()] });
        if (url.pathname === "/v1/computers" && method === "POST") {
          const name = JSON.parse(body).name as string;
          if (concurrentCreate) {
            // Another request with this key is still creating the computer.
            add("", "sleeping", concurrentCreate); concurrentCreate = null;
            return send(409, { error: { code: "idempotency_in_progress", message: "a create with this key is in progress" } });
          }
          const key = String(req.headers["idempotency-key"] ?? "");
          const replay = keys.get(key);
          if (replay) return send(201, { computer: replay });
          const computer = add("", "sleeping", name);
          keys.set(key, { ...computer });
          if (dropCreateAnswer) { dropCreateAnswer = false; req.socket.destroy(); return; }
          return send(201, { computer });
        }
        const computer = id ? fleet.get(id) : undefined;
        if (!computer) return send(404, { error: { code: "not_found", message: "no such computer" } });
        if (!action && method === "GET") {
          if (startsOnPoll && computer.state === "starting") computer.state = "running";
          return send(200, { computer });
        }
        if (!action && method === "PATCH") { computer.name = JSON.parse(body).name; return send(200, { computer }); }
        if (!action && method === "DELETE") { fleet.delete(computer.id); return send(200, { deleted: true }); }
        if (action === "wake") { computer.state = wakeTo; return send(200, { computer }); }
        if (action === "sleep") { computer.state = "sleeping"; return send(200, { computer }); }
        if (computer.state !== "running") return send(409, { error: { code: "asleep", message: "the computer is asleep" } });
        if (action === "exec") return send(200, { exitCode: 0, stdout: `ran ${String(JSON.parse(body).command).length} characters`, stderr: "" });
        if (action === "screenshot") { res.writeHead(200, { "content-type": "image/jpeg" }).end(frame); return; }
        if (action === "desktop") return send(200, { url: `https://desktop.example.test/${computer.id}?token=signed`, expiresAt: "2026-10-08T12:00:00Z" });
        return send(404, { error: { code: "not_found", message: "no such route" } });
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    port = (api.address() as { port: number }).port;
    keyDir = mkdtempSync(join(tmpdir(), "laterdog-computers-key-"));
    writeFileSync(join(keyDir, "computers-key"), `${KEY}\n`, { mode: 0o600 });
    vi.stubEnv("LATERDOG_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.stubEnv("LATERDOG_CLOUD_BOAT_URL", undefined);
    vi.stubEnv("LATERDOG_CLOUD_BOAT_TOKEN", undefined);
    vi.resetModules();
    computers = await import("./computers.ts");
    boat = await import("./boat.ts");
    const { DATA_DIR } = await import("./config.ts");
    environmentId = (await import("./environment.ts")).loadEnvironmentId(DATA_DIR);
  });

  beforeEach(() => {
    fleet.clear(); keys.clear(); failures.clear(); requests.length = 0;
    wakeTo = "running"; startsOnPoll = false; dropCreateAnswer = false; concurrentCreate = null; frame = JPEG;
    vi.stubEnv("LATERDOG_COMPUTERS_API", `http://127.0.0.1:${port}/v1`);
    vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", join(keyDir, "computers-key"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    rmSync(keyDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("leaves every call to Boat until later.dog's computers are set up", async () => {
    vi.stubEnv("LATERDOG_COMPUTERS_API", "");
    expect(computers.boatConfigured(noBoat)).toBe(false);
    expect(computers.boatConfigured(withBoat)).toBe(true);
    expect(computers.describeBoatAccount(withBoat)).toEqual(boat.describeBoatAccount(withBoat));
    expect(computers.boatAccount(withBoat)).toEqual(boat.boatAccount(withBoat));
    expect(await computers.findBoat(withBoat, "boat-bot")).toBeNull();
    expect(await computers.listManagedBoats(withBoat, [owner("boat-bot")])).toEqual({ configured: true, available: true, problem: null, instances: [] });
    expect(await computers.runCommand(withBoat, "bx_23456789", "true")).toEqual({ ok: true, exitCode: 0, stdout: "boat", stderr: "" });
    expect(await computers.inspectBoatIdentity(withBoat, "bx_23456789")).toEqual({ available: true, identity: null, problem: null });
    expect(ours()).toHaveLength(0);
    expect(requests.map((request) => request.path)).toEqual(["/api/box/v1/boxes", "/api/box/v1/boxes", "/api/box/v1/boxes/bx_23456789/commands", "/api/box/v1/boxes/bx_23456789"]);
    expect(computers.boatTurnLifecycleAction).toBe(boat.boatTurnLifecycleAction);
    expect(computers.isolatedRemoteCommand).toBe(boat.isolatedRemoteCommand);
    expect(computers.MAX_REMOTE_COMMAND_LENGTH).toBe(boat.MAX_REMOTE_COMMAND_LENGTH);
  });

  it("uses later.dog's computers once they are set up, with no Boat key", () => {
    expect(computers.boatConfigured(noBoat)).toBe(true);
    expect(computers.describeBoatAccount(noBoat)).toEqual({ configured: true, provider: "laterdog" });
    expect(computers.boatAccount(noBoat)).toEqual({ token: KEY, api: `http://127.0.0.1:${port}/v1`, included: false });
  });

  it("provisions one named computer per dog, wakes it and mints a fresh desktop link", async () => {
    const botId = "Research-Bot-0001";
    const first = await computers.provisionBoat(noBoat, botId, "Research");
    expect(nameFor(botId)).toMatch(/^dog-[a-f0-9]{12}-research-[a-f0-9]{6}$/);
    expect(first).toEqual({ boxId: expect.stringMatching(/^cmp_/), machineName: nameFor(botId), reused: false, state: "running",
      joinUrl: `https://desktop.example.test/${first.boxId}?token=signed` });
    expect(creates().map((request) => [request.headers["idempotency-key"], JSON.parse(request.body)])).toEqual([[keyFor(botId), { name: nameFor(botId) }]]);
    expect(ours().filter((request) => request.path.endsWith("/wake"))).toHaveLength(1);

    expect(await computers.provisionBoat(noBoat, botId, "Research")).toMatchObject({ boxId: first.boxId, reused: true, state: "running" });
    expect(creates()).toHaveLength(1);
    expect(fleet.size).toBe(1);
    expect(await computers.findBoat(noBoat, botId)).toEqual({ id: first.boxId, name: nameFor(botId), state: "running" });
    expect(await computers.boatStatus(noBoat, botId)).toEqual({ configured: true, box: { boxId: first.boxId, state: "running", desktopAvailable: null } });
    expect(await computers.boatStatus(noBoat, "never-made")).toEqual({ configured: true, box: null });
  });

  it("retries a create whose answer was lost with the same key, making one computer", async () => {
    dropCreateAnswer = true;
    const made = await computers.provisionBoat(noBoat, "lost-answer", "Lost");
    expect(fleet.size).toBe(1);
    expect(made).toMatchObject({ boxId: [...fleet.keys()][0], reused: false, state: "running" });
    expect(creates().map((request) => request.headers["idempotency-key"])).toEqual([keyFor("lost-answer"), keyFor("lost-answer")]);
  });

  it("uses the computer a concurrent create made instead of failing on the conflict", async () => {
    concurrentCreate = nameFor("racing-bot");
    const made = await computers.provisionBoat(noBoat, "racing-bot", "Racing");
    expect(fleet.size).toBe(1);
    expect(made).toMatchObject({ boxId: [...fleet.keys()][0], machineName: nameFor("racing-bot"), state: "running" });
  });

  it("gives a dog whose computer was deleted a new one, keyed by the one it replaces", async () => {
    const botId = "replaced-bot";
    const owners = [owner(botId)];
    const first = await computers.provisionBoat(noBoat, botId, "Replaced");
    expect(await computers.deleteManagedBoat(noBoat, owners, first.boxId, nameFor(botId))).toEqual({ ok: true });
    const second = await computers.provisionBoat(noBoat, botId, "Replaced");
    expect(await computers.deleteManagedBoat(noBoat, owners, second.boxId, nameFor(botId))).toEqual({ ok: true });
    const third = await computers.provisionBoat(noBoat, botId, "Replaced");
    expect(new Set([first.boxId, second.boxId, third.boxId]).size).toBe(3);
    expect([...fleet.keys()]).toEqual([third.boxId]);
    expect(creates().map((request) => request.headers["idempotency-key"])).toEqual([
      keyFor(botId), keyFor(botId), keyFor(botId, first.boxId), keyFor(botId), keyFor(botId, first.boxId), keyFor(botId, second.boxId),
    ]);
  });

  it("names a computer made under a dog's key for that dog again if something renamed it", async () => {
    const first = await computers.provisionBoat(noBoat, "renamed-bot", "Renamed");
    fleet.get(first.boxId)!.name = "renamed-by-hand";
    const again = await computers.provisionBoat(noBoat, "renamed-bot", "Renamed");
    expect(again).toMatchObject({ boxId: first.boxId, machineName: nameFor("renamed-bot") });
    expect(fleet.get(first.boxId)?.name).toBe(nameFor("renamed-bot"));
    expect(ours().filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("speaks the server's lifecycle words for the service's states", async () => {
    const cases: Array<[State, string, string]> = [
      ["running", "running", "attach"], ["sleeping", "archived", "wake"], ["stopping", "archiving", "wake"], ["starting", "starting", "wake"], ["error", "error", "wake"],
    ];
    for (const [state, word, action] of cases) {
      add(`state-${state}`, state);
      const found = await computers.findBoat(noBoat, `state-${state}`);
      expect(found.state).toBe(word);
      expect(computers.boatTurnLifecycleAction(found.state)).toBe(action);
    }
    expect(computers.boatTurnLifecycleAction((await computers.findBoat(noBoat, "state-none"))?.state ?? null)).toBe("provision");
    const inventory = await computers.listManagedBoats(noBoat, cases.map(([state]) => owner(`state-${state}`, state)));
    expect(Object.fromEntries(inventory.instances.map((instance) => [instance.ownerName, instance.state])))
      .toEqual({ running: "running", sleeping: "archived", stopping: "archiving", starting: "starting", error: "error" });
    add("twice-named", "running"); add("twice-named", "sleeping");
    await expect(computers.findBoat(noBoat, "twice-named")).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/Two cloud computers/) });
  });

  it("wakes a sleeping computer on demand, but never for a ready-only join", async () => {
    const computer = add("sleepy-bot", "sleeping");
    await expect(computers.joinReadyBoat(noBoat, "sleepy-bot")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/sleeping or starting/) });
    expect(ours().some((request) => request.path.endsWith("/wake"))).toBe(false);
    wakeTo = "starting"; startsOnPoll = true;
    expect(await computers.readyBoat(noBoat, "sleepy-bot")).toEqual({ id: computer.id, name: computer.name, state: "running" });
    expect(ours().filter((request) => request.path.endsWith("/wake"))).toHaveLength(1);
    const link = { joinUrl: `https://desktop.example.test/${computer.id}?token=signed`, state: "running" };
    expect(await computers.joinReadyBoat(noBoat, "sleepy-bot")).toEqual(link);
    computer.state = "sleeping"; wakeTo = "running";
    expect(await computers.joinBoat(noBoat, "sleepy-bot")).toEqual(link);
    await expect(computers.joinBoat(noBoat, "no-computer-bot")).rejects.toThrow("no computer yet");
  });

  it("keeps a refused wake's status and code for reading the failed place, and stops on a computer that keeps failing", async () => {
    const limited = add("limited-bot", "sleeping");
    failures.set(`POST /v1/computers/${limited.id}/wake`, { status: 402, error: { code: "at_once", message: "Your Pro plan includes 2 cloud computers at once" } });
    const refused = await computers.readyBoat(noBoat, "limited-bot").catch((error: unknown) => error as Record<string, unknown>);
    expect(refused).toMatchObject({ boatStatus: 402, boatCode: "at_once", message: "Your Pro plan includes 2 cloud computers at once" });
    expect(refused?.status).toBeUndefined();
    add("broken-bot", "error"); wakeTo = "error";
    expect(await computers.readyBoat(noBoat, "broken-bot")).toBeNull();
    expect(ours().filter((request) => request.path.endsWith("/wake"))).toHaveLength(2);
  });

  it("stops at once when a free trial refuses a wake", async () => {
    for (const [status, code] of [[409, "trial_used_up"], [409, "trial_ended"], [503, "trials_off"]] as const) {
      const computer = add(`${code}-bot`, "sleeping");
      failures.set(`POST /v1/computers/${computer.id}/wake`, { status, error: { code, message: `refused: ${code}` } });
      expect(await computers.readyBoat(noBoat, `${code}-bot`).catch((error: unknown) => error)).toMatchObject({ boatStatus: status, boatCode: code, message: `refused: ${code}` });
    }
    expect(ours().filter((request) => request.path.endsWith("/wake"))).toHaveLength(3);
  });

  it("tells Settings when the cloud computers are a free trial, and never counts the trial as other computers", () => {
    const trialHome = mkdtempSync(join(tmpdir(), "laterdog-trial-home-"));
    try {
      vi.stubEnv("LATERDOG_HOME", trialHome);
      vi.stubEnv("LATERDOG_COMPUTERS_API", "");
      expect(computers.describeBoatAccount(noBoat)).toEqual(boat.describeBoatAccount(noBoat));
      writeFileSync(join(trialHome, "computers-trial-key"), `ldt_${"t".repeat(43)}\n`, { mode: 0o600 });
      writeFileSync(join(trialHome, "computers-trial.json"), JSON.stringify({ api: `http://127.0.0.1:${port}/v1`, confirmed: true }));
      expect(computers.describeBoatAccount(withBoat)).toEqual({ configured: true, provider: "laterdog", trial: true });
      expect(computers.boatConfigured(noBoat)).toBe(true);
      expect(computers.otherComputersConfigured(noBoat)).toBe(false);
      expect(computers.otherComputersConfigured(withBoat)).toBe(true);
      writeFileSync(join(trialHome, "computers.json"), JSON.stringify({ api: `http://127.0.0.1:${port}/v1` }));
      expect(computers.describeBoatAccount(noBoat)).toEqual({ configured: true, provider: "laterdog" });
      expect(computers.otherComputersConfigured(noBoat)).toBe(true);
    } finally {
      vi.stubEnv("LATERDOG_HOME", undefined);
      rmSync(trialHome, { recursive: true, force: true });
    }
  });

  it("runs console commands in the clean environment and refuses oversized ones before any request", async () => {
    add("console-bot", "running");
    await expect(computers.execOnBoat(noBoat, "console-bot", "x".repeat(4001))).rejects.toThrow("maximum 4000 characters");
    expect(requests).toHaveLength(0);
    expect(await computers.execOnBoat(noBoat, "console-bot", `printf '%s' "$HOME"`)).toEqual({ exitCode: 0, stdout: expect.stringMatching(/^ran \d+ characters$/), stderr: "" });
    const sent = JSON.parse(ours().find((request) => request.path.endsWith("/exec"))!.body);
    expect(sent.command).toContain('exec env -i HOME="$HOME"');
    expect(sent.command).toContain("/bin/bash -c");
    expect(sent.timeoutMs).toBe(120_000);
  });

  it("routes a computer's commands and frames by its id, without resolving the dog again", async () => {
    const computer = add("tool-bot", "running");
    expect(await computers.runCommand(noBoat, computer.id, "xdotool getdisplaygeometry", { timeoutMs: 5_000 }))
      .toEqual({ ok: true, exitCode: 0, stdout: expect.any(String), stderr: "" });
    expect(await computers.screenshotBoat(noBoat, "", computer.id, { nativeSize: true })).toEqual({ png: JPEG.toString("base64"), format: "jpeg" });
    expect(ours().map((request) => `${request.method} ${request.path}`)).toEqual([`POST /v1/computers/${computer.id}/exec`, `GET /v1/computers/${computer.id}/screenshot`]);
    expect(await computers.screenshotBoat(noBoat, "tool-bot")).toEqual({ png: JPEG.toString("base64"), format: "jpeg" });

    computer.state = "sleeping";
    expect(await computers.runCommand(noBoat, computer.id, "true")).toEqual({ ok: false, exitCode: null, stdout: "", stderr: "the computer is asleep" });
    await expect(computers.screenshotBoat(noBoat, "tool-bot")).rejects.toThrow("the cloud computer is asleep");
    computer.state = "running"; frame = Buffer.alloc(8 * 1024 * 1024 + 1, 0xff);
    await expect(computers.screenshotBoat(noBoat, "", computer.id)).rejects.toThrow(/8 MB/);

    // A Boat computer a turn began on still reaches Boat, and one of later.dog's is never sent to Boat.
    expect(await computers.runCommand(withBoat, "bx_23456789", "true")).toEqual({ ok: true, exitCode: 0, stdout: "boat", stderr: "" });
    expect(requests.at(-1)?.path).toBe("/api/box/v1/boxes/bx_23456789/commands");
    vi.stubEnv("LATERDOG_COMPUTERS_API", "");
    const count = requests.length;
    await expect(computers.runCommand(withBoat, computer.id, "true")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not set up/) });
    expect(requests).toHaveLength(count);
  });

  it("asks the browser to quit before the computer sleeps, and reports a refused sleep", async () => {
    const computer = add("bedtime-bot", "running");
    expect(await computers.sleepBoat(noBoat, "bedtime-bot")).toEqual({ ok: true });
    expect(ours().filter((request) => request.method === "POST").map((request) => request.path.split("/").at(-1))).toEqual(["exec", "sleep"]);
    expect(JSON.parse(ours().find((request) => request.path.endsWith("/exec"))!.body).command).toContain("kill -TERM");
    expect(computer.state).toBe("sleeping");
    requests.length = 0;
    expect(await computers.sleepBoat(noBoat, "bedtime-bot")).toEqual({ ok: true });
    expect(ours().filter((request) => request.method === "POST")).toHaveLength(0);
    computer.state = "running";
    failures.set(`POST /v1/computers/${computer.id}/sleep`, { status: 503, error: { message: "snapshot store unavailable" } });
    await expect(computers.sleepBoat(noBoat, "bedtime-bot")).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/snapshot store unavailable/) });
    await expect(computers.sleepBoat(noBoat, "no-computer-bot")).rejects.toThrow("no computer for this dog");
  });

  it("lists only this installation's computers for Settings, owned first, and nothing it did not name", async () => {
    const owned = add("owned-bot", "running");
    const orphan = add("deleted-dog", "sleeping");
    add("", "running", "dog-ffffffffffff-other-123456");
    add("", "running", "my-production-box");
    const inventory = await computers.listManagedBoats(noBoat, [owner("owned-bot", "Research", true)]);
    expect(inventory).toEqual({ configured: true, available: true, problem: null, instances: [
      { boxId: owned.id, name: nameFor("owned-bot"), state: "running", ownerBotId: "owned-bot", ownerName: "Research", orphaned: false, inUse: true },
      { boxId: orphan.id, name: nameFor("deleted-dog"), state: "archived", ownerBotId: null, ownerName: null, orphaned: true, inUse: false },
    ] });
    expect(JSON.stringify(inventory)).not.toMatch(/other-123456|my-production-box/);
    failures.set("GET /v1/computers", { status: 503 });
    expect(await computers.listManagedBoats(noBoat, [])).toMatchObject({ configured: true, available: false, problem: expect.stringMatching(/503/), credentialRejected: false, instances: [] });
    failures.set("GET /v1/computers", { status: 401 });
    expect(await computers.listManagedBoats(noBoat, [])).toMatchObject({ available: false, credentialRejected: true, problem: expect.stringContaining("computers-key") });
  });

  it("sleeps and deletes only a freshly listed computer, under the route's claim", async () => {
    const computer = add("settings-bot", "running");
    const release = vi.fn();
    const claim = vi.fn((_instance: unknown) => release);
    const owners = [owner("settings-bot")];
    await expect(computers.sleepManagedBoat(noBoat, owners, "cmp_missing", claim)).rejects.toMatchObject({ status: 404 });
    await expect(computers.sleepManagedBoat(noBoat, [owner("settings-bot", "Busy", true)], computer.id, claim))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/in use/) });
    expect(await computers.sleepManagedBoat(noBoat, owners, computer.id, claim)).toEqual({ ok: true });
    expect(computer.state).toBe("sleeping");
    expect(claim.mock.calls.map(([instance]) => instance)).toEqual([expect.objectContaining({ boxId: computer.id, ownerBotId: "settings-bot" })]);
    expect(release).toHaveBeenCalledTimes(1);

    await expect(computers.deleteManagedBoat(noBoat, owners, computer.id, "not-its-name", claim)).rejects.toMatchObject({ status: 409 });
    expect(await computers.deleteManagedBoat(noBoat, owners, computer.id, computer.name, claim)).toEqual({ ok: true });
    expect(fleet.has(computer.id)).toBe(false);
    expect(release).toHaveBeenCalledTimes(2);

    // Gone between the list and the delete: deleted all the same. A refusal keeps its status for the route.
    const raced = add("raced-bot", "sleeping");
    failures.set(`DELETE /v1/computers/${raced.id}`, { status: 404 });
    expect(await computers.deleteManagedBoat(noBoat, [owner("raced-bot")], raced.id, raced.name)).toEqual({ ok: true });
    failures.set(`DELETE /v1/computers/${raced.id}`, { status: 500, error: { message: "snapshot store unavailable" } });
    await expect(computers.deleteManagedBoat(noBoat, [owner("raced-bot")], raced.id, raced.name))
      .rejects.toMatchObject({ status: 500, message: expect.stringMatching(/snapshot store unavailable/) });
  });

  it("inspects an identity at the service that issued its id", async () => {
    const computer = add("inspect-bot", "stopping");
    expect(await computers.inspectBoatIdentity(noBoat, computer.id)).toEqual({ available: true, identity: { boxId: computer.id, name: computer.name, state: "archiving" }, problem: null });
    fleet.delete(computer.id);
    expect(await computers.inspectBoatIdentity(noBoat, computer.id)).toEqual({ available: true, identity: null, problem: null });
  });

  it("fails a broken choice where the person sees it, never falling back to Boat", async () => {
    vi.stubEnv("LATERDOG_COMPUTERS_API", "http://computers.example.test/v1");
    expect(computers.boatConfigured(withBoat)).toBe(true);
    expect(computers.describeBoatAccount(withBoat)).toEqual({ configured: true, provider: "laterdog" });
    expect(computers.boatAccount(withBoat)).toBeNull();
    await expect(computers.findBoat(withBoat, "some-bot")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/HTTPS/) });
    expect(await computers.listManagedBoats(withBoat, [])).toMatchObject({ configured: true, available: false, problem: expect.stringMatching(/HTTPS/) });
    vi.stubEnv("LATERDOG_COMPUTERS_API", `http://127.0.0.1:${port}/v1`);
    vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", join(keyDir, "missing"));
    await expect(computers.provisionBoat(withBoat, "some-bot", "Some")).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/does not exist/) });
    expect(requests).toHaveLength(0);
  });
});
