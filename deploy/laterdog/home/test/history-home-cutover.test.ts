import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HistoryHomeCutover,
  type HomeHistoryPlacement,
  type HomeHistoryRequest,
  type ParkedHistoryDisk,
} from "../src/history-home-cutover.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stable = "1".repeat(64),
  machine = "hexample",
  physicalId = "2".repeat(64),
  nonce = "3".repeat(64);
const source: HomeHistoryPlacement = { mode: "dual", generation: "first", revision: 5 };
const target: HomeHistoryPlacement = { mode: "remote", generation: "first", revision: 7 };

function fixture() {
  const state = new Map<string, unknown>();
  const data = {
    running: true,
    idle: true,
    token: "before",
    manifest: "first",
    place: { ...source },
    phase: "serving" as ParkedHistoryDisk["phase"],
    snap: "",
    boot: "one",
    mode: "dual",
    generation: "first" as string | null,
    retires: 0,
    writes: 0,
    revokeFault: false,
    never: false,
    parkFault: false,
  };
  const permit = {
    v: 1,
    machineId: machine,
    physicalId,
    lease: sha(nonce),
    source,
    target,
    expiresAt: Date.now() + 60_000,
  };
  const bucket = {
    get: async (key: string) => {
      if (key === `homes/${stable}/history/home-cutover.json`) return { json: async () => permit };
      if (key === `homes/${stable}/manifest.json`)
        return { body: new Response(data.manifest).body, etag: sha(data.manifest) };
      return null;
    },
  } as unknown as R2Bucket;
  const hooks = {
    bucket,
    physicalId,
    storage: {
      get: async (k: string) => state.get(k),
      put: async (k: string, v: unknown) => {
        state.set(k, structuredClone(v));
      },
      delete: async (k: string) => state.delete(k),
    } as unknown as DurableObjectStorage,
    idle: async () => data.idle,
    running: () => data.running,
    writer: async () => data.token,
    placement: async () => data.place,
    neverActivated: async () => data.never,
    schedule: async () => {},
    retire: async () => {
      data.running = false;
      data.retires++;
    },
    revoke: async (old: string) => {
      if (data.token === old) data.token = "after";
      if (data.revokeFault) throw Error("Lost reply");
    },
    disk: async (action: string): Promise<ParkedHistoryDisk> => {
      if (data.parkFault) throw Error("Missing capability");
      if (action === "park" || action === "retry") data.phase = "parking";
      if (action === "abort" && data.phase === "parking") throw Error("Final save is pending");
      if (action === "abort") data.phase = "serving";
      return {
        boot: data.boot,
        mode: data.mode,
        generation: data.generation,
        phase: data.phase,
        manifest: data.snap,
        entries: 8,
      };
    },
  };
  let hold = new HistoryHomeCutover(hooks);
  return {
    data,
    permit,
    get hold() {
      return hold;
    },
    call: (r: HomeHistoryRequest) => hold.control(stable, machine, nonce, r),
    upgrade: async () => {
      hold = new HistoryHomeCutover(hooks);
      await hold.load();
    },
    saved: () => {
      data.phase = "saved";
      data.manifest = "last complete";
      data.snap = sha(data.manifest);
    },
    write: (token: string) =>
      hold.mutation(
        new Request("https://state.r2/manifest.json", { method: "PUT" }),
        () => data.token === token,
        async () => {
          data.writes++;
          return new Response(null, { status: 201 });
        },
      ),
  };
}

describe("history migration on the original coordinator", () => {
  it("requires actual idle capability and a matching complete save before writer fencing and cold retirement", async () => {
    const f = fixture();
    f.data.idle = false;
    await expect(f.call({ op: "begin" })).rejects.toThrow("finished");
    expect(f.hold.closed()).toBe(false);
    f.data.idle = true;
    f.data.parkFault = true;
    await expect(f.call({ op: "begin" })).rejects.toThrow("capability");
    expect(f.hold.closed()).toBe(false);
    f.data.parkFault = false;
    expect((await f.call({ op: "begin" })).phase).toBe("parking");
    expect((await f.write("before")).status).toBe(201);
    f.data.phase = "failed";
    await expect(f.call({ op: "status" })).rejects.toThrow("final coordinator save failed");
    expect(f.data.running).toBe(true);
    await f.call({ op: "renew" });
    f.saved();
    f.data.snap = sha("stale");
    await expect(f.call({ op: "status" })).rejects.toThrow("matching R2 snapshot");
    expect(f.data.token).toBe("before");
    f.saved();
    f.data.revokeFault = true;
    await expect(f.call({ op: "status" })).rejects.toThrow("Lost reply");
    expect((await f.write("before")).status).toBe(401);
    expect((await f.write("after")).status).toBe(423);
    await f.upgrade();
    f.data.revokeFault = false;
    const held = await f.call({ op: "status" });
    expect(held).toMatchObject({ phase: "held", manifest: sha("last complete"), physicalId, boot: "one" });
    expect(f.data.retires).toBe(1);
    await expect(f.call({ op: "release" })).rejects.toThrow("verification");
    await f.call({ op: "commit", manifest: sha("replacement") });
    await expect(f.call({ op: "commit", manifest: sha("different") })).rejects.toThrow("projection");
    await f.upgrade();
    await f.hold.recover();
    expect(f.hold.closed()).toBe(true);
    f.data.place = { ...target };
    await expect(f.call({ op: "release" })).rejects.toThrow("verification");
    f.data.manifest = "replacement";
    f.data.running = true;
    await expect(f.call({ op: "release" })).rejects.toThrow("verification");
    f.data.running = false;
    expect((await f.call({ op: "release" })).phase).toBe("released");
    expect((await f.call({ op: "release" })).phase).toBe("released");
    expect((await f.write("before")).status).toBe(401);
    expect((await f.write("after")).status).toBe(201);
  });

  it("matches the actual disk's generation in both migration directions", async () => {
    const forward = fixture();
    forward.data.generation = "stale";
    await expect(forward.call({ op: "begin" })).rejects.toThrow("original history store");
    forward.data.mode = "legacy";
    forward.data.generation = null;
    expect((await forward.call({ op: "begin" })).phase).toBe("parking");
    const reverse = fixture();
    reverse.permit.source = { mode: "remote", generation: "second", revision: 20 };
    reverse.permit.target = { mode: "legacy", generation: null, revision: 22 };
    reverse.data.place = reverse.permit.source;
    reverse.data.mode = "remote";
    await expect(reverse.call({ op: "begin" })).rejects.toThrow("original history store");
    reverse.data.generation = "second";
    expect((await reverse.call({ op: "begin" })).phase).toBe("parking");
    reverse.saved();
    expect((await reverse.call({ op: "status" })).phase).toBe("held");
    await reverse.call({ op: "commit", manifest: sha("reconstructed legacy") });
    await expect(reverse.call({ op: "release" })).rejects.toThrow("verification");
    reverse.data.place = reverse.permit.target;
    reverse.data.manifest = "reconstructed legacy";
    expect((await reverse.call({ op: "release" })).phase).toBe("released");
  });

  it("waits for admitted history writes and stays closed across expired leases, recovery and replacement disk failures", async () => {
    const f = fixture();
    let complete!: () => void;
    const inFlight = f.hold.historyRequest(async () => {
      await new Promise<void>((r) => {
        complete = r;
      });
      return new Response("saved");
    });
    await f.call({ op: "begin" });
    f.saved();
    expect((await f.call({ op: "status" })).phase).toBe("fencing");
    expect((await f.hold.historyRequest(async () => new Response())).status).toBe(423);
    expect(f.data.retires).toBe(0);
    complete();
    await inFlight;
    f.permit.expiresAt = 1;
    await f.upgrade();
    await f.hold.recover();
    expect(f.data.retires).toBe(1);
    expect(f.hold.closed()).toBe(true);
    const b = fixture();
    await b.call({ op: "begin" });
    b.data.boot = "replacement";
    await expect(b.call({ op: "status" })).rejects.toThrow("disk changed");
    await expect(b.call({ op: "abort" })).rejects.toThrow("different coordinator");
    expect(b.hold.closed()).toBe(true);
  });

  it("reopens a retained disk on failed save and requires proof of abandonment after directory changes", async () => {
    const f = fixture();
    await f.call({ op: "begin" });
    await expect(f.call({ op: "abort" })).rejects.toThrow("pending");
    f.data.phase = "failed";
    expect((await f.call({ op: "abort" })).phase).toBe("aborted");
    expect(f.data.phase).toBe("serving");
    const b = fixture();
    await b.call({ op: "begin" });
    b.saved();
    await b.call({ op: "status" });
    await b.call({ op: "commit", manifest: sha("replacement") });
    b.data.place = { mode: "legacy", revision: 8, generation: null };
    await expect(b.call({ op: "abort" })).rejects.toThrow("original history placement");
    b.data.never = true;
    b.data.manifest = "replacement";
    await expect(b.call({ op: "abort" })).rejects.toThrow("original coordinator snapshot");
    b.data.manifest = "last complete";
    expect((await b.call({ op: "abort" })).phase).toBe("aborted");
  });
});
