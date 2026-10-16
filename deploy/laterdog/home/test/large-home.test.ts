import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { StateBucket } from "../src/state.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { FakeNamespace, resetWorld, world } = await import("./fake-containers.ts");
const { CloudHomeHost, CloudHomeHostLarge, CloudHomeHostCandidate } = await import("../src/host.ts");
const { default: worker, HomesApi } = await import("../src/index.ts");
const { homeIdentity } = await import("../src/identity.ts");
const { HANDING_OVER } = await import("../src/handover.ts");

const OWNER = "owner-account";
const SOMEONE = "someone-else";
const SECRET = "test-home-secret";
const SUFFIX = "-home.later.dog";

function memoryBucket(): StateBucket & { objects: Map<string, ArrayBuffer> } {
  const objects = new Map<string, ArrayBuffer>();
  return {
    objects,
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async get(key) {
      const value = objects.get(key);
      return value ? { body: new Response(value).body as ReadableStream, httpEtag: '"etag"' } : null;
    },
    async put(key, value) {
      objects.set(key, value);
      return {};
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

type Host = InstanceType<typeof CloudHomeHost>;

function cloud(largeAccounts = "") {
  const HOMES = new FakeNamespace<Host>("HOMES");
  const HOMES_LARGE = new FakeNamespace<Host>("HOMES_LARGE");
  const HOMES_CANDIDATE = new FakeNamespace<Host>("HOMES_CANDIDATE");
  const STATE = memoryBucket();
  const env = {
    HOME_SECRET: SECRET,
    HOME_HOST_SUFFIX: SUFFIX,
    ADMIN_ORIGIN: "https://accounts.later.dog",
    INCLUDED_API: "https://cloud.later.dog/v1",
    LARGE_HOME_ACCOUNTS: largeAccounts,
    CANDIDATE_HOME_ACCOUNTS: "",
    CANDIDATE_HOME_CHECKPOINTS: "{}",
    CANDIDATE_HOME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    HOME_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    LARGE_HOME_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
    HOMES,
    HOMES_LARGE,
    HOMES_CANDIDATE,
    STATE,
    COMPUTERS: { fetch: async () => new Response("{}") },
    ACCOUNTS: {},
  };
  HOMES.bind((ctx) => new CloudHomeHost(ctx as never, env as never));
  HOMES_LARGE.bind((ctx) => new CloudHomeHostLarge(ctx as never, env as never));
  HOMES_CANDIDATE.bind((ctx) => new CloudHomeHostCandidate(ctx as never, env as never));
  const api = new HomesApi({} as never, env as never);
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await HOMES.settle();
      await HOMES_LARGE.settle();
      await HOMES_CANDIDATE.settle();
    }
  };
  const visit = async (machineId: string, path = "/api/bots") =>
    worker.fetch(new Request(`https://${machineId}${SUFFIX}${path}`, { headers: { accept: "application/json" } }), env as never);
  return { env, HOMES, HOMES_LARGE, HOMES_CANDIDATE, STATE, api, settle, visit };
}

async function checkpoint(f: ReturnType<typeof cloud>, lane: "standard" | "large" | "candidate", text = "saved sessions and provider authentication") {
  const identity = await homeIdentity(SECRET, OWNER, SUFFIX);
  const stateHome = f.HOMES.idFromName(identity.machineId).toString();
  const id = `checkpoint-${lane}`;
  const prefix = `checkpoints/${stateHome}/${id}/`;
  const hash = createHash("sha256").update(text).digest("hex");
  const manifest = JSON.stringify({ version: 1, createdAt: 1000, entries: [
    { path: ".laterdog/sessions.json", type: "file", chunks: [hash] },
    { path: ".laterdog/providers/owner/auth.json", type: "file", chunks: [hash] },
  ] });
  const store = (key: string, body: string) => f.STATE.objects.set(key, new TextEncoder().encode(body).buffer);
  store(`homes/${stateHome}/manifest.json`, manifest);
  store(`homes/${stateHome}/blobs/${hash}`, text);
  store(`${prefix}manifest.json`, manifest);
  store(`${prefix}blobs/${hash}`, text);
  const receipt = {
    schemaVersion: 1, accountId: OWNER, machineId: identity.machineId, stateHome, targetLane: lane,
    targetImageDigest: lane === "candidate" ? f.env.CANDIDATE_HOME_IMAGE_DIGEST : lane === "large" ? f.env.LARGE_HOME_IMAGE_DIGEST : f.env.HOME_IMAGE_DIGEST,
    sourceImageDigest: `sha256:${"d".repeat(64)}`, manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    evidenceSha256: "", proof: "quiesced-full-data", complete: true, completedAt: 1000,
  };
  const evidence = JSON.stringify({ ...receipt, scope: "full-data", quiesced: true, verifiedBlobs: true, workerReleaseProtocol: 1, unsaved: [], blobCount: 1, blobSetSha256: createHash("sha256").update(hash).digest("hex") });
  receipt.evidenceSha256 = createHash("sha256").update(evidence).digest("hex");
  store(`${prefix}evidence.json`, evidence);
  store(`${prefix}receipt.json`, JSON.stringify(receipt));
  f.env.CANDIDATE_HOME_CHECKPOINTS = JSON.stringify({ [OWNER]: id });
  return { identity, stateHome, prefix, hash, manifest, receipt, store };
}

async function machineOf(accountId: string): Promise<string> {
  return (await homeIdentity(SECRET, accountId, SUFFIX)).machineId;
}

function host(namespace: InstanceType<typeof FakeNamespace<Host>>, machineId: string): Host {
  return namespace.get(namespace.idFromName(machineId));
}

beforeEach(() => resetWorld());

describe("an account's candidate release", () => {
  it("requires explicit checkpoint selection before asking a current owner to stop", async () => {
    const f = cloud();
    const owner = await machineOf(OWNER);
    await f.api.open(OWNER);
    await f.settle();
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.visit(owner);
    await f.settle();
    expect(f.HOMES.machine(owner).signals).toBe(0);
    expect(f.HOMES.machine(owner).running).toBe(true);
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(false);
  });

  it.each(["standard", "large"] as const)("waits for the %s controller to refresh before stopping any owner or starting a candidate", async (oldLane) => {
    const f = cloud();
    const owner = await machineOf(OWNER);
    await f.api.open(OWNER);
    await f.settle();
    await checkpoint(f, "candidate");
    const old = vi.spyOn(host(oldLane === "standard" ? f.HOMES : f.HOMES_LARGE, owner), "releaseProtocol").mockRejectedValue(new Error("method not found on old Worker"));
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.visit(owner);
    await f.settle();
    expect(f.HOMES.machine(owner).running).toBe(true);
    expect(f.HOMES.machine(owner).signals).toBe(0);
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(false);
    old.mockRestore();
  });

  it("keeps another account stable and waits for all previous owners before restoring the same identity and state", async () => {
    const f = cloud();
    const owner = await machineOf(OWNER);
    const other = await machineOf(SOMEONE);
    await f.api.open(OWNER);
    await f.api.open(SOMEONE);
    await f.settle();
    const saved = await checkpoint(f, "candidate");
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.visit(owner);
    await f.settle();
    expect(f.HOMES.machine(owner).running).toBe(true);
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(false);
    expect(await host(f.HOMES, owner).standing()).toBe("released");
    expect(await host(f.HOMES_LARGE, owner).standing()).toBe("released");
    f.HOMES.machine(owner).exit?.();
    await f.visit(owner);
    await f.settle();
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(true);
    expect(f.HOMES.machine(other).running).toBe(true);
    expect(await (await f.visit(other)).text()).toBe("home HOMES /api/bots");
    const candidate = host(f.HOMES_CANDIDATE, owner) as unknown as { envVars: Record<string, string>; outbound: Record<string, { params: { home: string } }> };
    expect(candidate.envVars.LATERDOG_CLOUD_MACHINE_ID).toBe(saved.identity.machineId);
    expect(candidate.envVars.LATERDOG_PUBLIC_URL).toBe(saved.identity.origin);
    expect(candidate.outbound["state.r2"].params.home).toBe(saved.stateHome);
    expect(world.overlaps).toEqual([]);
  });

  it.each(["changed-manifest", "corrupt-evidence", "incomplete", "wrong-account", "wrong-image", "unverified-blobs"])("refuses %s proof after the previous owner exits", async (failure) => {
    const f = cloud();
    const owner = await machineOf(OWNER);
    await f.api.open(OWNER);
    await f.settle();
    const saved = await checkpoint(f, "candidate");
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.visit(owner);
    await f.settle();
    f.HOMES.machine(owner).exit?.();
    if (failure === "changed-manifest") saved.store(`homes/${saved.stateHome}/manifest.json`, "changed during shutdown");
    if (failure === "corrupt-evidence") saved.store(`${saved.prefix}evidence.json`, "corrupt");
    if (failure === "unverified-blobs") {
      const evidence = JSON.parse(new TextDecoder().decode(f.STATE.objects.get(`${saved.prefix}evidence.json`)));
      evidence.verifiedBlobs = false;
      const serialized = JSON.stringify(evidence);
      saved.store(`${saved.prefix}evidence.json`, serialized);
      saved.store(`${saved.prefix}receipt.json`, JSON.stringify({ ...saved.receipt, evidenceSha256: createHash("sha256").update(serialized).digest("hex") }));
    }
    if (failure === "incomplete") saved.store(`${saved.prefix}receipt.json`, JSON.stringify({ ...saved.receipt, complete: false }));
    if (failure === "wrong-account") saved.store(`${saved.prefix}receipt.json`, JSON.stringify({ ...saved.receipt, accountId: SOMEONE }));
    if (failure === "wrong-image") f.env.CANDIDATE_HOME_IMAGE_DIGEST = `sha256:${"f".repeat(64)}`;
    await f.visit(owner);
    await f.settle();
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(false);
    expect(world.overlaps).toEqual([]);
  });

  it.each(["standard", "large"] as const)("returns to the original %s lane only after a fresh checkpoint and candidate exit", async (original) => {
    const f = cloud(original === "large" ? OWNER : "");
    const owner = await machineOf(OWNER);
    await checkpoint(f, "candidate");
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.api.open(OWNER);
    await f.settle();
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(true);
    f.env.CANDIDATE_HOME_ACCOUNTS = "";
    await f.visit(owner);
    await f.settle();
    const old = original === "large" ? f.HOMES_LARGE : f.HOMES;
    expect(old.machine(owner).running).toBe(false);
    f.HOMES_CANDIDATE.machine(owner).exit?.();
    await f.visit(owner);
    await f.settle();
    expect(old.machine(owner).running).toBe(false);
    const saved = await checkpoint(f, original, "sessions and credentials after candidate acceptance");
    await f.visit(owner);
    await f.settle();
    expect(old.machine(owner).running).toBe(true);
    expect(new TextDecoder().decode(f.STATE.objects.get(`homes/${saved.stateHome}/manifest.json`))).toBe(saved.manifest);
    expect(await host(f.HOMES_CANDIDATE, owner).standing()).toBe("released");
    await host(f.HOMES_CANDIDATE, owner).wakeForRoutine();
    await host(f.HOMES_CANDIDATE, owner).maintain();
    await f.settle();
    expect(f.HOMES_CANDIDATE.machine(owner).running).toBe(false);
    expect(world.overlaps).toEqual([]);
  });

  it("removes every owner even after the account leaves the candidate list", async () => {
    const f = cloud();
    const owner = await machineOf(OWNER);
    await checkpoint(f, "candidate");
    f.env.CANDIDATE_HOME_ACCOUNTS = OWNER;
    await f.api.open(OWNER);
    await f.settle();
    f.env.CANDIDATE_HOME_ACCOUNTS = "";
    await f.api.remove(OWNER);
    for (const namespace of [f.HOMES, f.HOMES_LARGE, f.HOMES_CANDIDATE]) {
      expect(namespace.machine(owner).running).toBe(false);
      expect(await host(namespace, owner).summary()).toBeNull();
    }
    expect([...f.STATE.objects.keys()]).toEqual([]);
    expect(world.overlaps).toEqual([]);
  });
});

describe("which computer a home runs on", () => {
  it("keeps every home on the standard computer when nobody is listed", async () => {
    const { HOMES, HOMES_LARGE, api, settle, visit } = cloud();
    await api.open(OWNER);
    await settle();
    const machineId = await machineOf(OWNER);
    expect(HOMES.machine(machineId).running).toBe(true);
    expect(HOMES_LARGE.objects.size).toBe(0);
    expect(await (await visit(machineId)).text()).toBe("home HOMES /api/bots");
    expect(HOMES_LARGE.objects.size).toBe(0);
  });

  it("sends a listed owner to the large computer and everyone else to the standard one", async () => {
    const { HOMES, HOMES_LARGE, api, settle, visit } = cloud(` ${OWNER} ,not valid!, `);
    await api.open(OWNER);
    await api.open(SOMEONE);
    await settle();
    const owner = await machineOf(OWNER);
    const someone = await machineOf(SOMEONE);
    expect(HOMES_LARGE.machine(owner).running).toBe(true);
    expect(HOMES.machine(someone).running).toBe(true);
    expect([...HOMES_LARGE.objects.keys()]).toEqual([HOMES_LARGE.idFromName(owner).toString()]);
    expect(await (await visit(owner)).text()).toBe("home HOMES_LARGE /api/bots");
    expect(await (await visit(someone)).text()).toBe("home HOMES /api/bots");
    expect(world.overlaps).toEqual([]);
  });

  it("gives a listed owner's large home its owner even when the first visit is the home's own address", async () => {
    const { HOMES_LARGE, settle, visit } = cloud(OWNER);
    const owner = await machineOf(OWNER);
    expect((await visit(owner)).status).toBe(503);
    await settle();
    expect(HOMES_LARGE.machine(owner).running).toBe(true);
    expect(await (await visit(owner)).text()).toBe("home HOMES_LARGE /api/bots");
  });
});

describe("moving a home to the large computer", () => {
  it("waits for the standard container to save and stop, then starts the large one, never both", async () => {
    const { env, HOMES, HOMES_LARGE, api, settle, visit } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    const standard = HOMES.machine(owner);
    expect(standard.running).toBe(true);

    env.LARGE_HOME_ACCOUNTS = OWNER;
    expect((await visit(owner)).status).toBe(503);
    await settle();
    expect(standard.running).toBe(true);
    expect(standard.signals).toBe(1);
    expect(HOMES_LARGE.machine(owner).running).toBe(false);

    expect((await visit(owner)).status).toBe(503);
    await settle();
    expect(standard.signals).toBe(1);
    expect(HOMES_LARGE.machine(owner).running).toBe(false);

    standard.exit?.();
    expect((await visit(owner)).status).toBe(503);
    await settle();
    expect(HOMES_LARGE.machine(owner).running).toBe(true);
    expect(await (await visit(owner)).text()).toBe("home HOMES_LARGE /api/bots");
    expect(world.overlaps).toEqual([]);
  });

  it("never wakes the old standard container again: no routine, upkeep or health check starts it", async () => {
    const { env, HOMES, api, settle, visit } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    env.LARGE_HOME_ACCOUNTS = OWNER;
    await visit(owner);
    await settle();
    HOMES.machine(owner).exit?.();
    await visit(owner);
    await settle();

    const old = host(HOMES, owner);
    expect(await old.standing()).toBe("released");
    await old.wakeForRoutine();
    await old.maintain();
    await settle();
    expect(HOMES.machine(owner).running).toBe(false);
    expect((await old.containerFetch(new Request(`https://${owner}${SUFFIX}/api/health`))).status).toBe(500);
    await expect(old.startAndWaitForPorts()).rejects.toThrow(HANDING_OVER);
    expect(HOMES.machine(owner).starts).toBe(1);
    expect(world.overlaps).toEqual([]);
  });

  it("keeps the home's saved data where it was, so the large home restores the same files", async () => {
    const { env, HOMES, HOMES_LARGE, STATE, api, settle, visit } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    const standardId = HOMES.idFromName(owner).toString();
    const standardRoute = (host(HOMES, owner) as unknown as { outbound: Record<string, { params: { token: string; home: string } }> }).outbound["state.r2"];
    expect(standardRoute.params.home).toBe(standardId);
    const save = await CloudHomeHost.outboundHandlers!.state(
      new Request("http://state.r2/manifest.json", { method: "PUT", body: "saved by the standard home", headers: { authorization: `Bearer ${standardRoute.params.token}` } }),
      env,
      { containerId: standardId, className: "CloudHomeHost", params: standardRoute.params },
    );
    expect(save.status).toBe(201);

    env.LARGE_HOME_ACCOUNTS = OWNER;
    await visit(owner);
    await settle();
    const largeId = HOMES_LARGE.idFromName(owner).toString();
    expect(largeId).not.toBe(standardId);
    const largeRoute = (host(HOMES_LARGE, owner) as unknown as { outbound: Record<string, { params: { token: string; home: string } }> }).outbound["state.r2"];
    expect(largeRoute.params.home).toBe(standardId);
    const restored = await CloudHomeHostLarge.outboundHandlers!.state(
      new Request("http://state.r2/manifest.json", { headers: { authorization: `Bearer ${largeRoute.params.token}` } }),
      env,
      { containerId: largeId, className: "CloudHomeHostLarge", params: largeRoute.params },
    );
    expect(await restored.text()).toBe("saved by the standard home");
    expect([...STATE.objects.keys()]).toEqual([`homes/${standardId}/manifest.json`]);
  });

  it("moves back to the standard computer the same careful way when the owner is taken off the list", async () => {
    const { env, HOMES, HOMES_LARGE, api, settle, visit } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    env.LARGE_HOME_ACCOUNTS = OWNER;
    await visit(owner);
    await settle();
    HOMES.machine(owner).exit?.();
    await visit(owner);
    await settle();
    expect(HOMES_LARGE.machine(owner).running).toBe(true);

    env.LARGE_HOME_ACCOUNTS = "";
    await visit(owner);
    await settle();
    expect(HOMES.machine(owner).running).toBe(false);
    expect(HOMES_LARGE.machine(owner).signals).toBe(1);
    HOMES_LARGE.machine(owner).exit?.();
    await visit(owner);
    await settle();
    expect(HOMES.machine(owner).running).toBe(true);
    expect(HOMES.machine(owner).starts).toBe(2);
    expect(await host(HOMES_LARGE, owner).standing()).toBe("released");
    expect(await (await visit(owner)).text()).toBe("home HOMES /api/bots");
    expect(world.overlaps).toEqual([]);
  });

  it("never runs both when the two computers are asked for the home at the same moment", async () => {
    const { HOMES, HOMES_LARGE, api, settle } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    const request = () => new Request(`https://${owner}${SUFFIX}/api/bots`, { headers: { accept: "application/json" } });
    const standard = host(HOMES, owner);
    const large = host(HOMES_LARGE, owner);
    await large.adopt(await homeIdentity(SECRET, OWNER, SUFFIX));
    for (let round = 0; round < 12; round += 1) {
      await Promise.all([standard.fetch(request()), large.fetch(request()), large.fetch(request()), standard.fetch(request())]);
      await settle();
      if (round % 3 === 2) {
        HOMES.machine(owner).exit?.();
        HOMES_LARGE.machine(owner).exit?.();
      }
      const running = [HOMES.machine(owner).running, HOMES_LARGE.machine(owner).running].filter(Boolean);
      expect(running.length).toBeLessThanOrEqual(1);
    }
    expect(world.overlaps).toEqual([]);
  });
});

describe("removing a home that moved", () => {
  it("stops the large container and forgets the saved data and both records", async () => {
    const { env, HOMES, HOMES_LARGE, STATE, api, settle, visit } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    env.LARGE_HOME_ACCOUNTS = OWNER;
    await visit(owner);
    await settle();
    HOMES.machine(owner).exit?.();
    await visit(owner);
    await settle();
    STATE.objects.set(`homes/${HOMES.idFromName(owner).toString()}/manifest.json`, new ArrayBuffer(1));

    env.LARGE_HOME_ACCOUNTS = "";
    expect(await api.remove(OWNER)).toEqual({ removed: 1 });
    expect(HOMES_LARGE.machine(owner).running).toBe(false);
    expect(STATE.objects.size).toBe(0);
    expect(await host(HOMES, owner).summary()).toBeNull();
    expect(await host(HOMES_LARGE, owner).summary()).toBeNull();
  });
});

describe("a start that begins inside a request", () => {
  it("is not missed by the other computer taking the home", async () => {
    const { HOMES, HOMES_LARGE, api, settle } = cloud();
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    HOMES.machine(owner).exit?.();
    const standard = host(HOMES, owner);
    const large = host(HOMES_LARGE, owner);
    await large.adopt(await homeIdentity(SECRET, OWNER, SUFFIX));
    const request = () => new Request(`https://${owner}${SUFFIX}/api/bots`, { headers: { accept: "application/json" } });
    const inside = standard.containerFetch(request(), 8080);
    await Promise.all([large.fetch(request()), inside]);
    await settle();
    expect(world.overlaps).toEqual([]);
  });
});

describe("deleting a listed owner's home", () => {
  it("does not let any later request adopt or boot a home", async () => {
    const { HOMES, HOMES_LARGE, STATE, api, settle, visit } = cloud(OWNER);
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    expect(await api.remove(OWNER)).toEqual({ removed: 0 });
    HOMES_LARGE.machine(owner).exit?.();
    expect((await visit(owner)).status).toBe(404);
    await api.summary(OWNER);
    await settle();
    expect(await host(HOMES_LARGE, owner).summary()).toBeNull();
    expect(HOMES_LARGE.machine(owner).running).toBe(false);
    expect(HOMES.machine(owner).running).toBe(false);
    expect(STATE.objects.size).toBe(0);
    expect(world.overlaps).toEqual([]);
  });

  it("does not restore data into a request that lands while the account is being removed", async () => {
    const { HOMES, HOMES_LARGE, api, settle, visit } = cloud(OWNER);
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await settle();
    const removing = api.remove(OWNER);
    const visits = [visit(owner), visit(owner), visit(owner)];
    await Promise.all([removing, ...visits]);
    await settle();
    expect(HOMES.machine(owner).running).toBe(false);
    expect(HOMES_LARGE.machine(owner).running).toBe(false);
    expect(world.overlaps).toEqual([]);
  });

  it("opens again when the same account signs up again", async () => {
    const { HOMES_LARGE, api, settle } = cloud(OWNER);
    const owner = await machineOf(OWNER);
    await api.open(OWNER);
    await api.remove(OWNER);
    await api.open(OWNER);
    await settle();
    expect(HOMES_LARGE.machine(owner).running).toBe(true);
  });
});
