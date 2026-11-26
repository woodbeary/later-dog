import { hex, sha256, sha256Stream } from "./encoding.ts";
import { homePrefix } from "./state.ts";
import { handleWorkFolderPlacement } from "./work-folder-placement.ts";
import {
  workFolderPlacementSchema,
  type WorkFolderPlacement,
} from "../../../../shared/work-folder-layout.ts";

const hash = /^[0-9a-f]{64}$/;
const key = "workFolderReverse";
const leaseMs = 90_000;
type Phase =
  | "checking"
  | "draining"
  | "held"
  | "projecting"
  | "projected"
  | "publishing"
  | "committed";
interface State {
  lease: string;
  stable: string;
  machine: string;
  previous: string;
  until: number;
  phase: Phase;
  writer: string;
  source?: string;
  sourceEtag?: string;
  previousEtag?: string;
  raw?: string;
  target?: string;
}
interface Permit {
  v: number;
  machineId: string;
  lease: string;
  previous: string;
  expiresAt: number;
  completedRevision?: string;
}
export type ReverseRequest =
  | { op: "begin" | "renew" | "status" | "abort" | "finish" }
  | {
      op: "project";
      source: string;
      placement: WorkFolderPlacement;
      etag: string;
    }
  | {
      op: "publish";
      placement: WorkFolderPlacement;
      precondition: { "if-match": string };
    };
interface Hooks {
  bucket: R2Bucket;
  storage: DurableObjectStorage;
  idle: () => Promise<boolean>;
  cold: () => boolean;
  stop: () => void;
  writerEpoch: () => Promise<string>;
  revokeWriter: (original: string) => Promise<unknown>;
  schedule: () => Promise<unknown>;
}

export class WorkFolderReverse {
  private hold: State | null = null;
  constructor(private readonly hooks: Hooks) {}
  async load() {
    this.hold = (await this.hooks.storage.get<State>(key)) ?? null;
  }
  closed() {
    return this.hold !== null;
  }
  permitsFinalSave() {
    return this.hold?.phase === "draining";
  }
  private async save(value: State | null) {
    if (value) {
      this.hold = value;
      await this.hooks.storage.put(key, value);
    } else {
      await this.hooks.storage.delete(key);
      this.hold = null;
    }
  }
  private async object(stable: string, path: string) {
    const r = await this.hooks.bucket.get(homePrefix(stable) + path);
    if (!r) throw Error("A required reverse migration object is missing");
    return { sha: await sha256Stream(r.body), etag: '"' + r.etag + '"' };
  }
  private async current(h: State) {
    const placement = await this.object(h.stable, "work-folders/placement");
    if (placement.sha !== h.previous)
      throw Error("Original folder placement changed");
    return placement;
  }
  private receipt(h: State) {
    return {
      phase: h.phase,
      previous: h.previous,
      source: h.source,
      sourceEtag: h.sourceEtag,
      revision: h.target,
      expiresAt: h.until,
    };
  }
  private async holdCold(h: State) {
    if (!this.hooks.cold()) return h;
    const p = await this.current(h);
    await this.hooks.revokeWriter(h.writer);
    const m = await this.object(h.stable, "manifest.json");
    const held = {
      ...h,
      phase: "held" as const,
      source: m.sha,
      sourceEtag: m.etag,
      previousEtag: p.etag,
    };
    await this.save(held);
    return held;
  }
  async request(
    stable: string,
    machine: string,
    lease: string,
    r: ReverseRequest,
  ) {
    if (!hash.test(lease)) throw Error("Invalid reverse lease");
    const prefix = homePrefix(stable) + "work-folders/";
    const enrolled = await this.hooks.bucket.get(prefix + "reverse-enrollment");
    const p = await enrolled?.json<Permit>();
    if (
      !enrolled ||
      p?.v !== 1 ||
      p.lease !== lease ||
      p.machineId !== machine ||
      !hash.test(p.previous)
    )
      throw Error("Invalid reverse enrollment");
    let h = this.hold;
    if (
      h &&
      (h.stable !== stable ||
        h.machine !== machine ||
        h.lease !== lease ||
        h.previous !== p.previous)
    )
      throw Error("Different mounted home release");
    if (
      p.completedRevision &&
      (!h || h.phase === "committed") &&
      (r.op === "finish" || r.op === "status")
    ) {
      if (
        !hash.test(p.completedRevision) ||
        (await this.object(stable, "work-folders/placement")).sha !==
          p.completedRevision
      )
        throw Error("Completed reverse release changed");
      if (h) await this.save(null);
      return { phase: "finished", revision: p.completedRevision };
    }
    if (
      (!h || ["held", "draining"].includes(h.phase)) &&
      (!Number.isSafeInteger(p.expiresAt) ||
        p.expiresAt <= Date.now() ||
        p.expiresAt > Date.now() + 86_400_000)
    )
      throw Error("Expired reverse enrollment");
    if (!h && r.op === "begin") {
      const forward = await (
        await this.hooks.bucket.get(prefix + "cutover-enrollment")
      )?.json<{
        machineId: string;
        retired: boolean;
        retiredRevision: string;
      }>();
      if (
        !forward?.retired ||
        forward.retiredRevision !== p.previous ||
        forward.machineId !== machine ||
        (await this.object(stable, "work-folders/placement")).sha !==
          p.previous ||
        (await this.object(stable, "work-folders/placements/" + p.previous))
          .sha !== p.previous
      )
        throw Error("Original folder migration is not retired");
      h = {
        stable,
        machine,
        lease,
        previous: p.previous,
        phase: "checking",
        until: Date.now() + leaseMs,
        writer: await this.hooks.writerEpoch(),
      };
      await this.save(h);
      await this.hooks.schedule();
      try {
        if (!this.hooks.cold() && !(await this.hooks.idle()))
          throw Error("Mounted home is still busy");
      } catch (error) {
        await this.save(null);
        throw error;
      }
      h = { ...h, phase: "draining" };
      await this.save(h);
      if (!this.hooks.cold()) this.hooks.stop();
    }
    if (!h) {
      if (r.op === "status" || r.op === "abort") return { phase: "open" };
      throw Error("The mounted home is not held");
    }
    if (["held", "draining"].includes(h.phase) && h.until <= Date.now()) {
      await this.save(null);
      throw Error("Mounted home maintenance expired");
    }
    if (h.phase === "draining") h = await this.holdCold(h);
    if (r.op === "status") return this.receipt(h);
    if (r.op === "abort") {
      if (!["draining", "held"].includes(h.phase))
        throw Error("Reverse publication already started");
      await this.save(null);
      return { phase: "open" };
    }
    if (r.op === "begin" || r.op === "renew") {
      if (["draining", "held"].includes(h.phase)) {
        h = { ...h, until: Date.now() + leaseMs };
        await this.save(h);
      }
      return this.receipt(h);
    }
    if (!this.hooks.cold()) throw Error("Mounted source was restarted");
    if (r.op === "finish") {
      if (
        h.phase !== "committed" ||
        !h.target ||
        !h.raw ||
        (await this.object(stable, "work-folders/placement")).sha !==
          h.target ||
        (await this.object(stable, "manifest.json")).sha !==
          JSON.parse(h.raw).baselineManifest
      )
        throw Error(
          "Reverse placement and reconstructed manifest must be verified",
        );
      const done = await this.hooks.bucket.put(
        prefix + "reverse-enrollment",
        JSON.stringify({ ...p, completedRevision: h.target }),
        { onlyIf: { etagMatches: enrolled.etag } },
      );
      if (!done) throw Error("Reverse enrollment changed");
      await this.save(null);
      return { phase: "finished", revision: h.target };
    }
    if (r.op !== "project" && r.op !== "publish")
      throw Error("Unknown reverse operation");
    const raw = JSON.stringify(r.placement),
      id = hex(await sha256(raw));
    const parsed = workFolderPlacementSchema.safeParse(r.placement);
    if (
      !parsed.success ||
      parsed.data.mode !== "legacy" ||
      parsed.data.previous !== h.previous ||
      (h.target && (id !== h.target || raw !== h.raw))
    )
      throw Error("Different reconstructed placement");
    if (r.op === "project") {
      if (h.source !== r.source || h.sourceEtag !== r.etag)
        throw Error("Original saved coordinator changed");
      if (h.phase === "held") {
        await this.current(h);
        const present = await this.object(stable, "manifest.json");
        if (present.sha !== h.source || present.etag !== h.sourceEtag)
          throw Error("Original coordinator changed");
        h = { ...h, phase: "projecting", raw, target: id };
        await this.save(h);
      }
    } else {
      if (r.precondition["if-match"] !== h.previousEtag || !h.raw || !h.target)
        throw Error("Missing verified reverse projection");
      if (h.phase === "projected") {
        h = { ...h, phase: "publishing" };
        await this.save(h);
      }
    }
    return this.advance(h);
  }
  private async advance(h: State) {
    if (
      !h.raw ||
      !h.target ||
      !h.source ||
      !h.sourceEtag ||
      !h.previousEtag ||
      !this.hooks.cold()
    )
      throw Error("Missing cold mounted source proof");
    const obj = JSON.parse(h.raw) as WorkFolderPlacement;
    const invoke = async (
      path: string,
      method: string,
      body: string,
      etag: string,
      revision: string,
    ) => {
      const res = await handleWorkFolderPlacement(
        new Request("https://state.r2/work-folders/" + path, {
          method,
          body,
          headers: { "if-match": etag },
        }),
        this.hooks.bucket,
        h.stable,
      );
      if (!res.ok) {
        if (
          path === "project-legacy" &&
          [400, 409, 422].includes(res.status) &&
          (await this.object(h.stable, "manifest.json")).sha === h.source &&
          (await this.object(h.stable, "work-folders/placement")).sha ===
            h.previous
        ) {
          const { target, raw, ...original } = h;
          await this.save({ ...original, phase: "held" });
        }
        throw Error("Conditional reverse " + path + " was refused");
      }
      if ((await res.json<{ revision: string }>()).revision !== revision)
        throw Error("Conditional reverse " + path + " did not verify");
    };
    if (h.phase === "projecting") {
      await invoke(
        "project-legacy",
        "POST",
        JSON.stringify({ source: h.source, placement: obj }),
        h.sourceEtag,
        obj.baselineManifest,
      );
      h = { ...h, phase: "projected" };
      await this.save(h);
    }
    if (h.phase === "publishing") {
      await invoke("placement", "PUT", h.raw!, h.previousEtag!, h.target!);
      h = { ...h, phase: "committed" };
      await this.save(h);
    }
    if (
      (await this.object(h.stable, "manifest.json")).sha !==
        obj.baselineManifest ||
      (h.phase === "committed" &&
        (await this.object(h.stable, "work-folders/placement")).sha !==
          h.target)
    )
      throw Error("Reconstructed home readback failed");
    return this.receipt(h);
  }
  async recover() {
    const h = this.hold;
    if (!h) return;
    if (h.phase === "checking") {
      await this.save(null);
      return;
    }
    if (["draining", "held"].includes(h.phase) && h.until <= Date.now()) {
      await this.save(null);
      return;
    }
    if (h.phase === "committed") return;
    await this.hooks.schedule();
    if (h.phase === "draining") {
      if (!this.hooks.cold()) this.hooks.stop();
      else await this.holdCold(h);
    }
    if (h.phase === "projected" && h.until <= Date.now()) {
      const applying = { ...h, phase: "publishing" as const };
      await this.save(applying);
      await this.advance(applying);
    } else if (h.phase === "projecting" || h.phase === "publishing")
      await this.advance(h);
  }
}
