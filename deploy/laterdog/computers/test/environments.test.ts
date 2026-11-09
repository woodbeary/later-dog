import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_STUCK_MS,
  DEFAULT_SETUP_SCRIPT,
  type EnvironmentRow,
  MAINTENANCE_SCRIPT,
  REBUILD_AFTER_MS,
  REGISTER_SCRIPT,
  RETRY_FAILED_MS,
  SNAPSHOT_TTL_MS,
  TTL_MARGIN_MS,
  builderName,
  decideEnvironment,
  environmentKey,
  maintenanceFrom,
  parseEnvironmentRequest,
} from "../src/environments";
import { MINUTE } from "../src/idle";
import { DAY } from "../src/trial";
import { FAKE_IMAGE, type FakeContainer, OWNER_KEY, T0, type World, apiRequest, body, fakeImages, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  fakeImages.desktop = FAKE_IMAGE;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const REPO = "acme/site";
const last = (cmd: string[]) => cmd.at(-1) ?? "";
const isSetup = (cmd: string[]) => last(cmd).includes("laterdog_lock_key()") && !last(cmd).includes("laterdog-maintenance") && last(cmd) !== REGISTER_SCRIPT;
const isRegister = (cmd: string[]) => last(cmd) === REGISTER_SCRIPT;
const isMaintenance = (cmd: string[]) => last(cmd) === MAINTENANCE_SCRIPT;

async function prepare(w: World, input: Record<string, unknown> = { repository: REPO }) {
  const response = await w.fetch(apiRequest("POST", "/v1/environments", OWNER_KEY, { body: input }));
  return { status: response.status, environment: (await body(response)).environment };
}

async function listed(w: World) {
  return (await body(await w.fetch(apiRequest("GET", "/v1/environments", OWNER_KEY)))).environments;
}

function builder(w: World, key: string): FakeContainer {
  return w.containers.get(builderName("registry", key))!;
}

async function readyEnvironment(w: World, setupMs = 90_000): Promise<string> {
  const { environment } = await prepare(w);
  builder(w, environment.key).snapshots = 100;
  builder(w, environment.key).reply = (cmd) => {
    if (isSetup(cmd)) w.clock.now += setupMs;
    return undefined;
  };
  await w.advance(MINUTE);
  return environment.key;
}

async function create(w: World, extra: Record<string, unknown> = {}) {
  const response = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: extra }));
  return { status: response.status, computer: (await body(response)).computer };
}

async function read(w: World, id: string) {
  return (await body(await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY)))).computer;
}

const row = (fields: Partial<EnvironmentRow>): EnvironmentRow => ({ key: "env_x", repository: REPO, scriptHash: "s", image: "i", ...fields });

describe("keying an environment", () => {
  it("is the repository, the setup script and the image, and nothing else", async () => {
    const key = await environmentKey(REPO, DEFAULT_SETUP_SCRIPT, FAKE_IMAGE);
    expect(key).toMatch(/^env_[0-9a-f]{32}$/);
    expect(await environmentKey(REPO, DEFAULT_SETUP_SCRIPT, FAKE_IMAGE)).toBe(key);
    expect(await environmentKey("acme/other", DEFAULT_SETUP_SCRIPT, FAKE_IMAGE)).not.toBe(key);
    expect(await environmentKey(REPO, `${DEFAULT_SETUP_SCRIPT}pnpm build\n`, FAKE_IMAGE)).not.toBe(key);
    expect(await environmentKey(REPO, DEFAULT_SETUP_SCRIPT, `${FAKE_IMAGE}@sha256:2`)).not.toBe(key);
  });

  it("takes a GitHub owner/name and a bounded setup script, or null for the default", () => {
    expect(parseEnvironmentRequest({ repository: REPO })).toEqual({ ok: true, value: { repository: REPO } });
    expect(parseEnvironmentRequest({ repository: REPO, setupScript: null })).toEqual({ ok: true, value: { repository: REPO, setupScript: null } });
    for (const repository of ["acme", "acme/site/extra", "../x", "acme/..", "-acme/site", "acme/si te", 7]) {
      expect(parseEnvironmentRequest({ repository })).toMatchObject({ ok: false, refusal: { code: "invalid_repository" } });
    }
    expect(parseEnvironmentRequest({ repository: REPO, setupScript: " " })).toMatchObject({ ok: false, refusal: { code: "invalid_setup_script" } });
    expect(parseEnvironmentRequest({ repository: REPO, setupScript: "x".repeat(16 * 1024 + 1) })).toMatchObject({ ok: false, refusal: { code: "invalid_setup_script" } });
  });
});

describe("when an environment is used and rebuilt", () => {
  const now = T0;

  it("builds once when there is none, and not again while that build runs", () => {
    expect(decideEnvironment(undefined, now)).toEqual({ use: false, build: true, state: "none" });
    expect(decideEnvironment(row({ buildingSince: now - MINUTE }), now)).toEqual({ use: false, build: false, state: "building" });
    expect(decideEnvironment(row({ buildingSince: now - BUILD_STUCK_MS }), now)).toEqual({ use: false, build: true, state: "none" });
  });

  it("uses a fresh one, and keeps using one older than seven days while it rebuilds", () => {
    const snapshot = { id: "s", size: 1 };
    expect(decideEnvironment(row({ snapshot, builtAt: now - 6 * DAY }), now)).toEqual({ use: true, build: false, state: "fresh" });
    expect(decideEnvironment(row({ snapshot, builtAt: now - REBUILD_AFTER_MS }), now)).toEqual({ use: true, build: true, state: "stale" });
    expect(decideEnvironment(row({ snapshot, builtAt: now - REBUILD_AFTER_MS, buildingSince: now - MINUTE }), now)).toEqual({ use: true, build: false, state: "stale" });
  });

  it("stops using a snapshot before Cloudflare's 30 days run out, counting from the last restore", () => {
    const snapshot = { id: "s", size: 1 };
    const edge = SNAPSHOT_TTL_MS - TTL_MARGIN_MS;
    expect(decideEnvironment(row({ snapshot, builtAt: now - edge + MINUTE }), now)).toMatchObject({ use: true, build: true });
    expect(decideEnvironment(row({ snapshot, builtAt: now - edge }), now)).toEqual({ use: false, build: true, state: "expiring" });
    expect(decideEnvironment(row({ snapshot, builtAt: now - 29 * DAY, restoredAt: now - 2 * DAY }), now)).toEqual({ use: true, build: true, state: "stale" });
  });

  it("does not cache a setup over budget, and tries it again only after seven days", () => {
    const uncached = row({ outcome: "uncached", attemptAt: now - DAY });
    expect(decideEnvironment(uncached, now)).toEqual({ use: false, build: false, state: "uncached" });
    expect(decideEnvironment({ ...uncached, attemptAt: now - REBUILD_AFTER_MS }, now)).toMatchObject({ build: true });
  });

  it("retries a failed build after an hour and keeps the last good snapshot meanwhile", () => {
    expect(decideEnvironment(row({ outcome: "failed", attemptAt: now - MINUTE }), now)).toEqual({ use: false, build: false, state: "failed" });
    expect(decideEnvironment(row({ outcome: "failed", attemptAt: now - RETRY_FAILED_MS }), now)).toMatchObject({ build: true });
    const kept = row({ snapshot: { id: "s", size: 1 }, builtAt: now - 8 * DAY, outcome: "failed", attemptAt: now - MINUTE });
    expect(decideEnvironment(kept, now)).toEqual({ use: true, build: false, state: "stale" });
  });
});

describe("building an environment", () => {
  it("runs the setup once on a fresh computer from the image, snapshots it and clears the builder away", async () => {
    const w = await world();
    const { status, environment } = await prepare(w);
    expect(status).toBe(202);
    expect(environment).toMatchObject({ repository: REPO, state: "building", building: true, custom: false });
    const container = builder(w, environment.key);
    expect(container.starts).toEqual([expect.objectContaining({ image: FAKE_IMAGE })]);
    container.reply = (cmd) => {
      if (isSetup(cmd)) w.clock.now += 90_000;
      return undefined;
    };
    await w.advance(MINUTE);
    const setup = container.execs.find((exec) => isSetup(exec.cmd))!;
    expect(last(setup.cmd)).toContain(DEFAULT_SETUP_SCRIPT);
    expect(setup.cmd.slice(0, 3)).toEqual(["timeout", "--kill-after=5", "300.000s"]);
    expect(setup.options).toMatchObject({ user: "1000:1000", env: { LATERDOG_REPOSITORY: REPO, LATERDOG_REPOSITORY_DIR: `/home/dog/repos/${REPO}`, LATERDOG_RUN_KEY: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(container.execs.some((exec) => isRegister(exec.cmd))).toBe(true);
    expect(container.snapshots).toBe(1);
    expect(container.running).toBe(false);
    const instance = w.computers.instances.get(builderName("registry", environment.key)) as unknown as { ctx: { storage: { kv: { keys(): string[] } } } };
    expect(instance.ctx.storage.kv.keys()).toEqual([]);
    expect(await listed(w)).toEqual([expect.objectContaining({ key: environment.key, state: "fresh", building: false, setupMs: 90_000, lastOutcome: "ready" })]);
    expect((await body(await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY)))).computers).toEqual([]);
  });

  it("does not cache a setup that runs over five minutes, and says so", async () => {
    const w = await world();
    const { environment } = await prepare(w);
    const container = builder(w, environment.key);
    container.reply = (cmd) => {
      if (!isSetup(cmd)) return undefined;
      w.clock.now += 6 * MINUTE;
      return { exitCode: 124 };
    };
    await w.advance(MINUTE);
    expect(container.snapshots).toBe(0);
    expect(container.execs.some((exec) => isRegister(exec.cmd))).toBe(false);
    const [entry] = await listed(w);
    expect(entry).toMatchObject({ state: "uncached", lastOutcome: "uncached", building: false });
    expect(entry.error).toMatch(/longer than 5 minutes, so it was not saved/);
    const { computer } = await create(w, { repository: REPO });
    expect(w.containers.get(computer.id)!.starts).toEqual([expect.objectContaining({ image: FAKE_IMAGE })]);
    expect(container.starts).toHaveLength(1);
  });

  it("reports a failing setup and keeps nothing", async () => {
    const w = await world();
    const { environment } = await prepare(w);
    const container = builder(w, environment.key);
    container.reply = (cmd) => (isSetup(cmd) ? { exitCode: 128, stderr: "fatal: repository not found" } : undefined);
    await w.advance(MINUTE);
    expect(container.snapshots).toBe(0);
    expect(await listed(w)).toEqual([expect.objectContaining({ state: "failed", error: expect.stringContaining("fatal: repository not found") })]);
  });

  it("rebuilds under a new key when the setup script or the image changes", async () => {
    const w = await world();
    const first = await readyEnvironment(w);
    const scripted = await prepare(w, { repository: REPO, setupScript: "set -e\ngit clone https://github.com/acme/site.git \"$LATERDOG_REPOSITORY_DIR\"\n" });
    expect(scripted.environment).toMatchObject({ state: "building", custom: true });
    expect(scripted.environment.key).not.toBe(first);
    await w.advance(MINUTE);
    expect(await listed(w)).toEqual([expect.objectContaining({ key: scripted.environment.key, state: "fresh", custom: true })]);

    fakeImages.desktop = `${FAKE_IMAGE}@sha256:next`;
    const imaged = await prepare(w);
    expect(imaged.environment.key).not.toBe(scripted.environment.key);
    expect(imaged.environment.state).toBe("building");
    const { computer } = await create(w, { repository: REPO });
    expect(w.containers.get(computer.id)!.starts).toEqual([expect.objectContaining({ image: `${FAKE_IMAGE}@sha256:next` })]);
  });

  it("rebuilds a seven-day-old environment while computers keep starting from it", async () => {
    const w = await world();
    const key = await readyEnvironment(w);
    const builtAt = Date.parse((await listed(w))[0].builtAt);
    w.clock.now = builtAt + REBUILD_AFTER_MS;
    const { computer } = await create(w, { repository: REPO });
    expect(w.containers.get(computer.id)!.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "snapshot-101" } })]);
    expect(builder(w, key).starts).toHaveLength(2);
    await w.advance(MINUTE);
    const [rebuilt] = await listed(w);
    expect(rebuilt).toMatchObject({ key, state: "fresh" });
    expect(Date.parse(rebuilt.builtAt) - builtAt).toBeGreaterThanOrEqual(REBUILD_AFTER_MS);
  });

  it("is not offered to a free trial, whose computers start from the image as before", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("a");
    await startTrial(w, key);
    const refused = await w.fetch(apiRequest("POST", "/v1/environments", key, { body: { repository: REPO } }));
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.code).toBe("environments_not_in_trial");
    expect((await w.fetch(apiRequest("GET", "/v1/environments", key))).status).toBe(403);
    const created = await w.fetch(apiRequest("POST", "/v1/computers", key, { body: { repository: REPO } }));
    expect(created.status).toBe(201);
    const { computer } = await body(created);
    expect(w.containers.get(computer.id)!.starts).toEqual([expect.objectContaining({ image: FAKE_IMAGE })]);
    expect([...w.containers.keys()].filter((name) => name.startsWith("environment"))).toEqual([]);
  });
});

describe("a dog's computer starting work on a repository", () => {
  it("starts from the environment snapshot when it has none of its own, and resets the snapshot's 30 days", async () => {
    const w = await world();
    await readyEnvironment(w);
    const before = (await listed(w))[0].expiresAt;
    w.clock.now += 5 * DAY;
    const { status, computer } = await create(w, { repository: REPO });
    expect(status).toBe(201);
    const container = w.containers.get(computer.id)!;
    expect(container.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "snapshot-101" } })]);
    expect(container.starts[0]).not.toHaveProperty("image");
    expect(computer.environment).toEqual({ repository: REPO, restoredFrom: "snapshot-101" });
    const after = (await listed(w))[0].expiresAt;
    expect(Date.parse(after)).toBe(Date.parse(computer.createdAt) + SNAPSHOT_TTL_MS);
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    await w.advance(MINUTE);
    expect((await read(w, computer.id)).state).toBe("running");
  });

  it("starts from the image and builds the environment for the next computer when there is none yet", async () => {
    const w = await world();
    const first = await create(w, { repository: REPO });
    expect(w.containers.get(first.computer.id)!.starts).toEqual([expect.objectContaining({ image: FAKE_IMAGE })]);
    expect(first.computer.environment).toBeUndefined();
    await w.advance(MINUTE);
    expect(await listed(w)).toEqual([expect.objectContaining({ state: "fresh" })]);
    const second = await create(w, { repository: REPO });
    expect(w.containers.get(second.computer.id)!.starts).toEqual([expect.objectContaining({ containerSnapshot: { id: "snapshot-1" } })]);
  });

  it("wakes from the environment when it has no snapshot of its own yet, and from its own once it has one", async () => {
    const w = await world();
    const { computer } = await create(w, { repository: REPO });
    await w.advance(MINUTE);
    const container = w.containers.get(computer.id)!;
    container.running = false;
    expect((await read(w, computer.id)).state).toBe("error");
    const woken = await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/wake`, OWNER_KEY, { body: { repository: REPO } }));
    expect(woken.status).toBe(200);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
    await w.advance(MINUTE);
    await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/sleep`, OWNER_KEY));
    await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/wake`, OWNER_KEY, { body: { repository: REPO } }));
    expect(container.snapshots).toBe(1);
    expect(container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snapshot-1" } });
  });

  it("falls back to the image after a restore from the environment fails", async () => {
    const w = await world();
    await readyEnvironment(w);
    const { computer } = await create(w, { repository: REPO });
    const container = w.containers.get(computer.id)!;
    container.running = false;
    w.clock.now += 31_000;
    await w.advance(MINUTE);
    expect((await read(w, computer.id)).state).toBe("error");
    await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/wake`, OWNER_KEY, { body: { repository: REPO } }));
    expect(container.starts.at(-1)).toMatchObject({ image: FAKE_IMAGE });
  });

  it("refuses a repository that is not owner/name", async () => {
    const w = await world();
    const { status, computer } = await create(w, { repository: "acme/site; rm -rf /" });
    expect(status).toBe(400);
    expect(computer).toBeUndefined();
  });
});

describe("maintenance on wake", () => {
  it("fetches and installs what changed after each start, as the dog, and shows what it did", async () => {
    const w = await world();
    await readyEnvironment(w);
    const { computer } = await create(w, { repository: REPO });
    const container = w.containers.get(computer.id)!;
    let runs = 0;
    container.reply = (cmd) => {
      if (!isMaintenance(cmd)) return undefined;
      runs += 1;
      w.clock.now += 3_000;
      return { stdout: runs === 1 ? "laterdog-maintenance fetched=1 installed=1\n" : "laterdog-maintenance fetched=1 installed=0\n" };
    };
    await w.advance(MINUTE);
    const maintenance = container.execs.find((exec) => isMaintenance(exec.cmd))!;
    expect(maintenance.options).toMatchObject({ user: "1000:1000", env: { LATERDOG_REPOSITORY: REPO } });
    expect((await read(w, computer.id)).environment).toMatchObject({ repository: REPO, maintenance: { fetched: "yes", installed: "yes", ms: 3_000 } });
    await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/sleep`, OWNER_KEY));
    await w.fetch(apiRequest("POST", `/v1/computers/${computer.id}/wake`, OWNER_KEY));
    await w.advance(MINUTE);
    expect(runs).toBe(2);
    expect((await read(w, computer.id)).environment.maintenance).toMatchObject({ fetched: "yes", installed: "no" });
  });

  it("runs no maintenance on a computer that never started from an environment", async () => {
    const w = await world();
    const { computer } = await create(w);
    await w.advance(MINUTE);
    expect(w.containers.get(computer.id)!.execs.some((exec) => isMaintenance(exec.cmd))).toBe(false);
  });

  it("reads the maintenance line", () => {
    expect(maintenanceFrom("x\nlaterdog-maintenance fetched=1 installed=failed\n")).toEqual({ fetched: "yes", installed: "failed" });
    expect(maintenanceFrom("laterdog-maintenance fetched=none installed=0")).toEqual({ fetched: "no_checkout", installed: "no" });
    expect(maintenanceFrom("nothing")).toBeUndefined();
  });
});

const MEASURED = { bootFromImageMs: 6_600, bootFromSnapshotMs: 5_700 };
const ASSUMED = { setupMs: 150_000, maintenanceMs: 4_000 };

describe("time to ready for work on a repository (recorded boot times, assumed setup times)", () => {
  it("is boot plus maintenance from the environment, against boot plus the whole setup from the image", async () => {
    const w = await world();
    await readyEnvironment(w, ASSUMED.setupMs);

    const plain = await create(w);
    const fromImage = w.containers.get(plain.computer.id)!;
    let imageReadyAt = 0;
    fromImage.rfbAnswers = () => {
      if (!imageReadyAt) imageReadyAt = (w.clock.now += MEASURED.bootFromImageMs);
      return true;
    };
    fromImage.reply = (cmd) => {
      if (last(cmd).includes(DEFAULT_SETUP_SCRIPT)) w.clock.now += ASSUMED.setupMs;
      return undefined;
    };
    await w.advance(MINUTE);
    const before = w.clock.now;
    const setup = await w.fetch(apiRequest("POST", `/v1/computers/${plain.computer.id}/exec`, OWNER_KEY, { body: { command: DEFAULT_SETUP_SCRIPT, timeoutMs: 600_000 } }));
    expect(setup.status).toBe(200);
    const imageReadyMs = imageReadyAt - Date.parse(plain.computer.createdAt) + (w.clock.now - before);

    const saved = await create(w, { repository: REPO });
    const fromSnapshot = w.containers.get(saved.computer.id)!;
    let snapshotBooted = false;
    fromSnapshot.rfbAnswers = () => {
      if (!snapshotBooted) w.clock.now += MEASURED.bootFromSnapshotMs;
      snapshotBooted = true;
      return true;
    };
    fromSnapshot.reply = (cmd) => {
      if (isMaintenance(cmd)) w.clock.now += ASSUMED.maintenanceMs;
      return isMaintenance(cmd) ? { stdout: "laterdog-maintenance fetched=1 installed=0\n" } : undefined;
    };
    await w.advance(MINUTE);
    const maintained = (await read(w, saved.computer.id)).environment.maintenance;
    const snapshotReadyMs = Date.parse(maintained.at) - Date.parse(saved.computer.createdAt);

    expect(fromSnapshot.execs.some((exec) => last(exec.cmd).includes(DEFAULT_SETUP_SCRIPT))).toBe(false);
    expect(imageReadyMs).toBe(250 + MEASURED.bootFromImageMs + ASSUMED.setupMs);
    expect(snapshotReadyMs).toBe(250 + MEASURED.bootFromSnapshotMs + ASSUMED.maintenanceMs);
    console.info(`time to ready for work: ${imageReadyMs} ms from the image, ${snapshotReadyMs} ms from the environment`);
    expect(snapshotReadyMs).toBeLessThan(imageReadyMs / 10);
  });
});
