import { hex, sha256, sha256Stream } from "./encoding.ts";
import { homePrefix } from "./state.ts";

type Mode = "legacy" | "dual" | "remote";
export type HomeHistoryPlacement = { mode: Mode; generation: string | null; revision: number };
export type HomeHistoryRequest =
  | { op: "begin" | "renew" | "status" | "abort" | "release" }
  | { op: "commit"; manifest: string };
type Phase = "checking" | "parking" | "fencing" | "held" | "committed" | "aborting" | "released" | "aborted";
interface Permit {
  v: number;
  machineId: string;
  physicalId: string;
  lease: string;
  source: HomeHistoryPlacement;
  target: HomeHistoryPlacement;
  expiresAt: number;
}
interface Hold {
  stable: string;
  machine: string;
  lease: string;
  source: HomeHistoryPlacement;
  target: HomeHistoryPlacement;
  phase: Phase;
  writer: string;
  until: number;
  boot?: string;
  manifest?: string;
  etag?: string;
  projected?: string;
}
export interface ParkedHistoryDisk {
  boot: string;
  mode: string;
  generation: string | null;
  phase: "serving" | "parking" | "saved" | "failed";
  manifest?: string;
  entries?: number;
}
interface Hooks {
  storage: DurableObjectStorage;
  bucket: R2Bucket;
  physicalId: string;
  idle(): Promise<boolean>;
  running(): boolean;
  disk(action: "park" | "status" | "retry" | "abort", lease: string): Promise<ParkedHistoryDisk>;
  placement(stable: string): Promise<HomeHistoryPlacement>;
  neverActivated(stable: string, generation: string): Promise<boolean>;
  writer(): Promise<string>;
  revoke(writer: string): Promise<unknown>;
  retire(): Promise<unknown>;
  schedule(): Promise<unknown>;
}
const hash = /^[0-9a-f]{64}$/;
const stateKey = "homeHistoryCutover";
const same = (a: HomeHistoryPlacement, b: HomeHistoryPlacement) =>
  a.mode === b.mode && a.generation === b.generation && a.revision === b.revision;
function placement(value: HomeHistoryPlacement | undefined): boolean {
  return (
    !!value &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    (value.mode === "legacy"
      ? value.generation === null
      : ["dual", "remote"].includes(value.mode) &&
        typeof value.generation === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.generation))
  );
}

export class HistoryHomeCutover {
  private current: Hold | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private historyRequests = 0;
  private readonly hooks: Hooks;
  constructor(hooks: Hooks) {
    this.hooks = hooks;
  }
  async load() {
    this.current = (await this.hooks.storage.get<Hold>(stateKey)) ?? null;
  }
  closed() {
    return !!this.current && this.current.phase !== "released" && this.current.phase !== "aborted";
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private async store(h: Hold) {
    if (h.phase !== "released" && h.phase !== "aborted") this.current = h;
    await this.hooks.storage.put(stateKey, h);
    this.current = h;
    return h;
  }
  private reply(h: Hold) {
    return {
      phase: h.phase,
      physicalId: this.hooks.physicalId,
      source: h.source,
      target: h.target,
      manifest: h.manifest,
      etag: h.etag,
      projected: h.projected,
      boot: h.boot,
      expiresAt: h.until,
    };
  }
  private async manifest(stable: string) {
    const object = await this.hooks.bucket.get(homePrefix(stable) + "manifest.json");
    if (!object) throw Error("The coordinator snapshot is missing");
    return { manifest: await sha256Stream(object.body), etag: '"' + object.etag + '"' };
  }
  async historyRequest(action: () => Promise<Response>): Promise<Response> {
    if (this.closed() && !["checking", "parking", "aborting"].includes(this.current!.phase))
      return new Response("Conversation storage is held", { status: 423 });
    this.historyRequests++;
    try {
      return await action();
    } finally {
      this.historyRequests--;
    }
  }
  mutation(request: Request, authenticated: () => boolean, action: () => Promise<Response>) {
    return this.serial(async () => {
      if (!authenticated()) return new Response("Retired home writer", { status: 401 });
      if (this.closed()) {
        const path = new URL(request.url).pathname;
        const finalWrite =
          request.method === "PUT" &&
          (path === "/manifest.json" ||
            path === "/archive/index.json" ||
            path.startsWith("/archive/blobs/") ||
            path.startsWith("/restore-points/"));
        if (!["checking", "parking", "aborting"].includes(this.current!.phase) || !finalWrite)
          return new Response("Coordinator storage is held", { status: 423 });
      }
      return action();
    });
  }
  private async advance(h: Hold, retry: boolean): Promise<Hold> {
    if (h.phase === "checking") {
      let ready: ParkedHistoryDisk;
      try {
        if (!this.hooks.running() || !(await this.hooks.idle()))
          throw Error("Open the compatible home and wait until all work has finished");
        ready = await this.hooks.disk("status", h.lease);
        const original = ready.mode === h.source.mode && ready.generation === h.source.generation;
        const beforeDual = h.source.mode === "dual" && ready.mode === "legacy" && ready.generation === null;
        if (ready.phase !== "serving" || !ready.boot || (!original && !beforeDual))
          throw Error("The running coordinator does not match the original history store");
      } catch (error) {
        await this.hooks.storage.delete(stateKey);
        this.current = null;
        throw error;
      }
      h = await this.store({ ...h, phase: "parking", boot: ready.boot });
    }
    if (h.phase === "parking") {
      if (!this.hooks.running()) throw Error("The original disk stopped before confirming a complete save");
      let disk = await this.hooks.disk("status", h.lease);
      if (disk.boot !== h.boot) throw Error("The original disk changed during its final save");
      if (disk.phase === "serving") disk = await this.hooks.disk("park", h.lease);
      if (disk.phase === "failed" && retry) disk = await this.hooks.disk("retry", h.lease);
      if (disk.phase === "failed") throw Error("The final coordinator save failed; the original disk remains parked");
      if (disk.phase !== "saved") return h;
      const actual = await this.manifest(h.stable);
      if (
        disk.boot !== h.boot ||
        !hash.test(disk.manifest ?? "") ||
        actual.manifest !== disk.manifest ||
        !Number.isSafeInteger(disk.entries) ||
        disk.entries! <= 0
      )
        throw Error("The final coordinator save has no matching R2 snapshot");
      h = await this.store({ ...h, phase: "fencing", ...actual });
    }
    if (h.phase === "fencing") {
      if (this.historyRequests) return h;
      const actual = await this.manifest(h.stable);
      if (actual.manifest !== h.manifest || actual.etag !== h.etag)
        throw Error("The saved coordinator snapshot changed before fencing");
      await this.hooks.revoke(h.writer);
      if ((await this.hooks.writer()) === h.writer) throw Error("Old coordinator writer is still live");
      if (this.hooks.running()) await this.hooks.retire();
      if (!this.hooks.running()) h = await this.store({ ...h, phase: "held" });
    }
    return h;
  }
  control(stable: string, machine: string, nonce: string, request: HomeHistoryRequest) {
    return this.serial(async () => {
      if (!hash.test(nonce) || !hash.test(stable)) throw Error("Invalid coordinator history hold");
      const lease = hex(await sha256(nonce));
      const permit = await (
        await this.hooks.bucket.get(homePrefix(stable) + "history/home-cutover.json")
      )?.json<Permit>();
      if (
        permit?.v !== 1 ||
        permit.machineId !== machine ||
        permit.physicalId !== this.hooks.physicalId ||
        permit.lease !== lease ||
        !placement(permit.source) ||
        !placement(permit.target) ||
        !["remote", "legacy"].includes(permit.target.mode) ||
        (permit.target.mode === "legacy") !== (permit.source.mode === "remote") ||
        (permit.source.mode === "dual" && permit.target.generation !== permit.source.generation) ||
        permit.target.revision <= permit.source.revision ||
        !Number.isSafeInteger(permit.expiresAt)
      )
        throw Error("Invalid coordinator history enrollment");
      let h = this.current;
      if (h && this.closed() && (h.stable !== stable || h.machine !== machine || h.lease !== lease))
        throw Error("Another coordinator history hold is active");
      if (h?.lease === lease && (!same(h.source, permit.source) || !same(h.target, permit.target)))
        throw Error("Coordinator history enrollment changed");
      if (h?.lease === lease && !this.closed()) return this.reply(h);
      if (!this.closed()) {
        if (
          request.op !== "begin" ||
          permit.expiresAt <= Date.now() ||
          !same(await this.hooks.placement(stable), permit.source)
        )
          throw Error("The original history placement changed or the hold expired");
        h = await this.store({
          stable,
          machine,
          lease,
          source: permit.source,
          target: permit.target,
          phase: "checking",
          writer: await this.hooks.writer(),
          until: Date.now() + 90_000,
        });
      }
      if (!h || h.lease !== lease) throw Error("No coordinator history hold");
      if (request.op === "abort") return this.reply(await this.abort(h));
      if (request.op === "release") {
        if (
          h.phase !== "committed" ||
          this.hooks.running() ||
          (await this.hooks.writer()) === h.writer ||
          !same(await this.hooks.placement(stable), h.target) ||
          (await this.manifest(stable)).manifest !== h.projected
        )
          throw Error("Target history placement and coordinator snapshot need verification");
        return this.reply(await this.store({ ...h, phase: "released" }));
      }
      if (request.op === "commit") {
        if (
          !hash.test(request.manifest) ||
          !["held", "committed"].includes(h.phase) ||
          (h.projected && h.projected !== request.manifest) ||
          this.hooks.running()
        )
          throw Error("The final coordinator snapshot is not held for this projection");
        if (h.phase === "held") {
          const actual = await this.manifest(stable);
          if (actual.manifest !== h.manifest || actual.etag !== h.etag) throw Error("The frozen coordinator changed");
        }
        return this.reply(await this.store({ ...h, phase: "committed", projected: request.manifest }));
      }
      if (!["begin", "status", "renew"].includes(request.op)) throw Error("Unknown coordinator history operation");
      if (request.op === "renew") h = await this.store({ ...h, until: Date.now() + 90_000 });
      await this.hooks.schedule();
      return this.reply(await this.advance(h, request.op === "renew"));
    });
  }
  private async abort(h: Hold): Promise<Hold> {
    const current = await this.hooks.placement(h.stable);
    if (!same(current, h.source)) {
      const abandoned =
        h.source.mode === "dual" &&
        h.source.generation &&
        current.mode === "legacy" &&
        current.generation === null &&
        current.revision > h.source.revision &&
        (await this.hooks.neverActivated(h.stable, h.source.generation));
      if (!abandoned) throw Error("Restore the original history placement before reopening the coordinator");
    }
    if (h.manifest && (await this.manifest(h.stable)).manifest !== h.manifest)
      throw Error("Restore the original coordinator snapshot before reopening");
    if (h.phase === "fencing") h = await this.advance(h, false);
    if (h.phase === "fencing") throw Error("Coordinator writer retirement is still pending");
    if (h.phase === "checking") return this.store({ ...h, phase: "aborted" });
    if (h.phase === "parking" || h.phase === "aborting") {
      if (!this.hooks.running()) throw Error("The original disk stopped without a verified final save");
      const disk = await this.hooks.disk("status", h.lease);
      if (disk.boot !== h.boot) throw Error("Cannot release a different coordinator disk");
      h = await this.store({ ...h, phase: "aborting" });
      if (disk.phase !== "serving") {
        const released = await this.hooks.disk("abort", h.lease);
        if (released.boot !== h.boot || released.phase !== "serving")
          throw Error("Original coordinator did not resume");
      }
    } else if (this.hooks.running()) throw Error("A stale coordinator appeared during rollback");
    return this.store({ ...h, phase: "aborted" });
  }
  recover() {
    return this.serial(async () => {
      const h = this.current;
      if (!h || !this.closed()) return;
      if (["checking", "parking", "fencing"].includes(h.phase)) {
        await this.hooks.schedule();
        await this.advance(h, false);
      }
    });
  }
}
