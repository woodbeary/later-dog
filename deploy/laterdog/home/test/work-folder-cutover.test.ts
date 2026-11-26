import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkFolderCutover } from "../src/work-folder-cutover.ts";
import { workFolderLayoutRecord } from "../../../../shared/work-folder-layout.ts";

const stable = "1".repeat(64),
  lease = "2".repeat(64),
  image = "3".repeat(64),
  machine = "hhometest";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  let interrupted: "before" | "after" | null = null;
  let configured: string | null = image;
  let phase = "open",
    token = true,
    retired = false,
    idle = true;
  const map = new Map<string, string>(),
    state = new Map<string, unknown>(),
    prefix = "homes/" + stable + "/";
  const bucket = {
    async get(key: string) {
      const raw = map.get(key);
      if (raw === undefined) return null;
      return {
        body: new Response(raw).body,
        etag: sha(raw),
        arrayBuffer: async () => new TextEncoder().encode(raw).buffer,
        json: async () => JSON.parse(raw),
      };
    },
    async head(key: string) {
      return map.has(key) ? {} : null;
    },
    async put(
      key: string,
      b: unknown,
      opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
    ) {
      const old = map.get(key);
      if (
        (opts?.onlyIf?.etagDoesNotMatch === "*" && old !== undefined) ||
        (opts?.onlyIf?.etagMatches &&
          (!old || sha(old) !== opts.onlyIf.etagMatches))
      )
        return null;
      if (
        key === prefix + "work-folders/placement" &&
        interrupted === "before"
      ) {
        interrupted = null;
        throw Error("Dropped publication");
      }
      map.set(key, await new Response(b as BodyInit).text());
      if (
        key === prefix + "work-folders/placement" &&
        interrupted === "after"
      ) {
        interrupted = null;
        throw Error("Dropped receipt");
      }
      return { etag: sha(map.get(key)!) };
    },
  };
  const disk = {
    running: true,
    async exec(args: string[]) {
      const { op } = JSON.parse(args.at(-1)!);
      if (op === "begin") phase = "held";
      if (op === "abort") phase = "open";
      if (op === "seal" && phase === "held") phase = "sealed";
      return {
        stdout: new Response(
          JSON.stringify({ boot: "boot-1", mountId: "43", phase, stopped: 4 }),
        ).body,
        exitCode: Promise.resolve(0),
      };
    },
  };
  const hooks = {
    physicalId: stable,
    writerEpoch: async () => "original-generation",
    revokeWriter: async () => {
      token = false;
    },
    configuredImage: () => configured,
    bucket: bucket as unknown as R2Bucket,
    disk: () => disk as unknown as NonNullable<DurableObjectState["container"]>,
    storage: {
      get: async (k: string) => state.get(k),
      put: async (k: string, v: unknown) => state.set(k, structuredClone(v)),
      delete: async (k: string) => state.delete(k),
    } as unknown as DurableObjectStorage,
    idle: async () => idle,
    cold: () => !disk.running,
    stop: () => {
      disk.running = false;
    },
    schedule: async () => {},
    retire: async () => {
      retired = true;
      token = false;
      disk.running = false;
    },
  };
  let service = new WorkFolderCutover(hooks);
  const ctl = (op: "begin" | "renew" | "abort" | "retire" | "status") =>
    service.control(stable, machine, lease, { op });
  const put = (raw: string, frozen?: string) =>
    service.mutation(
      new Request("http://state.r2/manifest.json", {
        method: "PUT",
        headers: frozen ? { "x-laterdog-frozen-save": frozen } : {},
        body: raw,
      }),
      () => token,
      async () => {
        map.set(prefix + "manifest.json", raw);
        return new Response(null, { status: 201 });
      },
    );
  const permit = {
    v: 1,
    machineId: machine,
    lease,
    image,
    expiresAt: Date.now() + 3600_000,
  };
  map.set(prefix + "work-folders/cutover-enrollment", JSON.stringify(permit));
  const layout = { dogs: [], tasks: {}, projects: [] },
    manifest = JSON.stringify({ version: 1, entries: [] }),
    baseline = sha(manifest);
  const proof = JSON.stringify({
      v: 1,
      mode: "folders",
      baselineManifest: baseline,
      layoutSha256: sha(workFolderLayoutRecord(layout)),
      scopes: [],
    }),
    verification = sha(proof);
  const placement = {
    v: 1 as const,
    mode: "folders" as const,
    previous: null,
    baselineManifest: baseline,
    verification,
    layout,
  };
  const restored = {
    v: 1,
    stable,
    machineId: machine,
    lease,
    sourceBoot: "boot-1",
    sourceMountId: "43",
    sourceDisk: stable + "/boot-1",
    candidateDisk:
      "8".repeat(64) + "/3493e902-33b8-4826-b30e-bd0023908a6f/64800",
    restoreResult: "",
    image,
    baselineManifest: baseline,
    verification,
    restored: true,
    appStarted: false,
  };
  map.set(prefix + "work-folders/verification/" + verification, proof);
  map.set(
    prefix + "work-folders/registry",
    JSON.stringify({ page: null, fence: verification }),
  );
  map.set(prefix + "work-folders/legacy-seals/" + baseline, "1");
  const run = JSON.stringify({
    v: 1,
    stable,
    image,
    verification,
    baselineManifest: baseline,
    placement: sha(JSON.stringify(placement)),
    index: "9".repeat(64),
  });
  const readback = JSON.stringify({
    state: "verified",
    run: sha(run),
    candidateDisk: restored.candidateDisk,
    scopes: 0,
  });
  map.set(prefix + "work-folders/cutover-runs/" + sha(run), run);
  map.set(
    prefix + "work-folders/cutover-restore-results/" + sha(readback),
    readback,
  );
  restored.restoreResult = sha(readback);
  const publish = async (receipt = restored) => {
    const b = JSON.stringify(receipt),
      id = sha(b);
    map.set(prefix + "work-folders/cutover-candidates/" + id, b);
    return service.control(stable, machine, lease, {
      op: "publish",
      placement,
      precondition: { "if-none-match": "*" },
      candidate: id,
    });
  };
  return {
    ctl,
    put,
    reverse: (
      request: import("../src/work-folder-reverse.ts").ReverseRequest,
    ) => service.reverseControl(stable, machine, lease, request),
    closed: () => service.closed(),
    publish,
    restored,
    manifest,
    map,
    prefix,
    baseline,
    placement,
    service,
    source: () => phase,
    retired: () => retired,
    setImage: (next: string | null) => {
      configured = next;
    },
    interrupt: (where: "before" | "after") => {
      interrupted = where;
    },
    setBusy: () => {
      idle = false;
    },
    restart: async () => {
      service = new WorkFolderCutover(hooks);
      await service.load();
    },
    recover: () => service.recover(),
  };
}
afterEach(() => vi.useRealTimers());
describe("original home working folder cutover", () => {
  it("requires a quiet source and restores the old writer on an expired lease after controller restart", async () => {
    vi.useFakeTimers();
    const busy = fixture();
    busy.setBusy();
    await expect(busy.ctl("begin")).rejects.toThrow("active work");
    const h = fixture();
    await h.ctl("begin");
    expect((await h.put("late normal save")).status).toBe(423);
    expect((await h.put(h.manifest, lease)).status).toBe(201);
    await h.restart();
    expect((await h.put("late restored writer")).status).toBe(423);
    vi.advanceTimersByTime(66_000);
    await h.recover();
    expect(h.source()).toBe("open");
    expect((await h.put("normal resumed")).status).toBe(201);
    expect((await h.put("late stale snapshot", lease)).status).toBe(409);
  });
  it("requires the exact physical restore and never thaws a committed source across restart or replay", async () => {
    const h = fixture();
    await h.ctl("begin");
    await h.put(h.manifest, lease);
    for (const invalid of [
      { sourceBoot: "other" },
      { candidateDisk: h.restored.sourceDisk },
      { appStarted: true },
      { verification: "e".repeat(64) },
    ]) {
      await expect(h.publish({ ...h.restored, ...invalid })).rejects.toThrow(
        "does not verify",
      );
      expect(h.source()).toBe("held");
    }
    const target = sha(JSON.stringify(h.placement));
    expect(await h.publish()).toEqual({ phase: "committed", revision: target });
    expect(h.source()).toBe("sealed");
    await h.restart();
    await h.recover();
    await expect(h.ctl("abort")).rejects.toThrow("cannot thaw");
    expect(await h.publish()).toEqual({ phase: "committed", revision: target });
    expect((await h.put("old write")).status).toBe(401);
    await h.ctl("retire");
    expect(h.retired()).toBe(true);
    expect((await h.put("old late write")).status).toBe(401);
    expect(h.map.get(h.prefix + "manifest.json")).toBe(h.manifest);
  });
  it.each(["before", "after"] as const)(
    "reconciles a controller restart %s the R2 commit unambiguously",
    async (where) => {
      const h = fixture();
      await h.ctl("begin");
      await h.put(h.manifest, lease);
      h.interrupt(where);
      await expect(h.publish()).rejects.toThrow(/Dropped/);
      expect(h.source()).toBe("sealed");
      await h.restart();
      await h.recover();
      expect(await h.publish()).toEqual({
        phase: "committed",
        revision: sha(JSON.stringify(h.placement)),
      });
      await expect(h.ctl("abort")).rejects.toThrow("cannot thaw");
      h.setImage("0".repeat(64));
      await expect(h.ctl("retire")).rejects.toThrow("has not been selected");
      expect(h.retired()).toBe(false);
      h.setImage(image);
      await h.ctl("retire");
      expect(await h.ctl("retire")).toEqual({
        phase: "retired",
        revision: sha(JSON.stringify(h.placement)),
      });
    },
  );
  it("drains an already admitted R2 mutation before establishing the disk hold", async () => {
    const h = fixture();
    let finish!: () => void;
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    const write = h.service.mutation(
      new Request("http://state.r2/manifest.json", { method: "PUT" }),
      () => true,
      async () => {
        await pending;
        return new Response(null, { status: 201 });
      },
    );
    const begin = h.ctl("begin");
    await Promise.resolve();
    expect(h.source()).toBe("open");
    finish();
    expect((await write).status).toBe(201);
    await begin;
    expect(h.source()).toBe("held");
    await h.ctl("abort");
  });
});

describe("mounted home reverse publication", () => {
  function mounted() {
    const h = fixture(),
      original = JSON.stringify(h.placement),
      previous = sha(original);
    h.map.set(
      h.prefix + "work-folders/cutover-enrollment",
      JSON.stringify({
        v: 1,
        machineId: machine,
        lease,
        retired: true,
        retiredRevision: previous,
      }),
    );
    h.map.set(
      h.prefix + "work-folders/reverse-enrollment",
      JSON.stringify({
        v: 1,
        machineId: machine,
        lease,
        previous,
        expiresAt: Date.now() + 3600_000,
      }),
    );
    h.map.set(h.prefix + "work-folders/placement", original);
    h.map.set(h.prefix + "work-folders/placements/" + previous, original);
    h.map.set(h.prefix + "manifest.json", h.manifest);
    const raw = JSON.stringify({
        version: 1,
        entries: [],
        edited: "after forward",
      }),
      baselineManifest = sha(raw);
    const proof = JSON.stringify({
        v: 1,
        mode: "legacy",
        baselineManifest,
        layoutSha256: sha(workFolderLayoutRecord(h.placement.layout)),
        scopes: [],
      }),
      verification = sha(proof);
    const placement = {
      ...h.placement,
      mode: "legacy" as const,
      previous,
      baselineManifest,
      verification,
    };
    h.map.set(h.prefix + "work-folders/verification/" + verification, proof);
    h.map.set(
      h.prefix + "work-folders/registry",
      JSON.stringify({ page: null, fence: verification }),
    );
    h.map.set(
      h.prefix + "work-folders/legacy-manifests/" + baselineManifest,
      raw,
    );
    h.map.set(h.prefix + "work-folders/legacy-seals/" + baselineManifest, "1");
    return {
      h,
      raw,
      project: {
        op: "project" as const,
        source: h.baseline,
        etag: '"' + h.baseline + '"',
        placement,
      },
      publish: {
        op: "publish" as const,
        placement,
        precondition: { "if-match": '"' + previous + '"' },
      },
    };
  }
  it("preserves the projected post-switch edit through lost publication and a reconstructed owner", async () => {
    const { h, project, publish, raw } = mounted();
    expect((await h.reverse({ op: "begin" })).phase).toBe("held");
    expect(h.closed()).toBe(true);
    expect((await h.put("delayed mounted save")).status).toBe(401);
    await expect(
      h.reverse({ ...project, source: "9".repeat(64) }),
    ).rejects.toThrow("changed");
    expect((await h.reverse(project)).phase).toBe("projected");
    expect(h.map.get(h.prefix + "manifest.json")).toBe(raw);
    await expect(h.reverse({ op: "abort" })).rejects.toThrow("publication");
    h.interrupt("after");
    await expect(h.reverse(publish)).rejects.toThrow("Dropped");
    await h.restart();
    expect(h.closed()).toBe(true);
    await h.recover();
    expect((await h.reverse(publish)).phase).toBe("committed");
    expect((await h.reverse({ op: "finish" })).phase).toBe("finished");
    expect(h.closed()).toBe(false);
    expect((await h.reverse({ op: "finish" })).phase).toBe("finished");
  });
  it("expires an uncommitted reverse hold after restart and never interrupts a busy home", async () => {
    vi.useFakeTimers();
    const busy = mounted().h;
    busy.setBusy();
    await expect(busy.reverse({ op: "begin" })).rejects.toThrow("busy");
    expect(busy.closed()).toBe(false);
    const { h } = mounted();
    await h.reverse({ op: "begin" });
    await h.restart();
    vi.advanceTimersByTime(91_000);
    await h.recover();
    expect(h.closed()).toBe(false);
    expect(h.map.get(h.prefix + "manifest.json")).toBe(h.manifest);
  });
});
