import {
  WorkFolderReverse,
  type ReverseRequest,
} from "./work-folder-reverse.ts";
import freezeProgram from "./work-folder-freeze.program.txt";
import saveProgram from "./work-folder-frozen-save.program.txt";
import { hex, sha256, sha256Stream } from "./encoding.ts";
import { homePrefix } from "./state.ts";
import {
  handleWorkFolderPlacement,
  layoutScopes,
} from "./work-folder-placement.ts";
import {
  workFolderPlacementSchema,
  type WorkFolderPlacement,
} from "../../../../shared/work-folder-layout.ts";

const digest = /^[a-f0-9]{64}$/;
const milliseconds = 65_000;
const holding = "workFolderCutover";
type Container = NonNullable<DurableObjectState["container"]>;
type Phase = "arming" | "held" | "publishing" | "committed" | "retiring";
export interface FrozenDisk {
  phase: "arming" | "held" | "sealed" | "open";
  boot: string;
  mountId?: string;
  stopped?: number;
  remaining?: number;
}
interface Hold {
  lease: string;
  machineId: string;
  writerEpoch: string;
  stable: string;
  image: string;
  phase: Phase;
  expiresAt: number;
  disk?: FrozenDisk;
  baselineManifest?: string;
  savedEntries?: number;
  target?: string;
  candidate?: string;
  publication?: { raw: string; precondition: Record<string, string> };
  reverseReturn?: { lease: string; revision: string };
}
export type CutoverRequest =
  | { op: "begin" | "renew" | "status" | "abort" | "snapshot" }
  | { op: "retire"; selection?: string }
  | {
      op: "publish";
      placement: WorkFolderPlacement;
      precondition: Record<string, string>;
      candidate: string;
    };
interface Hooks {
  bucket: R2Bucket;
  disk: () => Container | undefined;
  storage: DurableObjectStorage;
  idle: () => Promise<boolean>;
  cold?: () => boolean;
  stop?: () => void;
  schedule: () => Promise<unknown>;
  retire: (originalDisk: boolean) => Promise<unknown>;
  physicalId: string;
  writerEpoch: () => Promise<string>;
  revokeWriter: (original: string) => Promise<unknown>;
  configuredImage: () => string | null;
}
async function jsonObject<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const o = await bucket.get(key);
  return o ? o.json<T>() : null;
}
async function physical<T>(
  container: Container,
  program: string,
  args: string[],
): Promise<T> {
  const command =
    program === freezeProgram
      ? ["python3", "-c", program, ...args]
      : ["node", "--input-type=module", "--eval", program, ...args];
  const child = await container.exec(command, {
    user: "root",
    stderr: "ignore",
  });
  const [bytes, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exitCode,
  ]);
  if (code !== 0 || bytes.length > 2048)
    throw Error("The original home could not complete its disk operation");
  return JSON.parse(bytes) as T;
}
export function cutoverMutable(request: Request): boolean {
  if (!["PUT", "DELETE", "POST"].includes(request.method)) return false;
  const path = new URL(request.url).pathname;
  return (
    path === "/manifest.json" ||
    path === "/archive/index.json" ||
    path === "/work-folders/placement" ||
    path === "/work-folders/project-legacy" ||
    path.startsWith("/restore-points/") ||
    path.startsWith("/archive/blobs/") ||
    (request.method === "DELETE" && path.startsWith("/blobs/"))
  );
}
export class WorkFolderCutover {
  private hold: Hold | null = null;
  private queued: Promise<unknown> = Promise.resolve();
  private readonly reverse;
  private sealedSource: { leaseSha256: string; previous: string } | null = null;
  constructor(private readonly hooks: Hooks) {
    this.reverse = new WorkFolderReverse({
      ...hooks,
      sealed: () => this.sealedSource,
      cold: hooks.cold ?? (() => !hooks.disk()?.running),
      stop:
        hooks.stop ??
        (() => {
          throw Error("Mounted home cannot be stopped");
        }),
    });
  }

  private async withOriginal<T>(
    h: Hold | null,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!h) return action();
    if (h.phase !== "committed" || !h.target || !h.baselineManifest || !h.disk)
      throw Error("Original forward placement has not committed");
    if (this.hooks.disk()?.running) {
      const disk = await this.command("status", h.lease);
      if (
        disk.phase !== "sealed" ||
        disk.boot !== h.disk.boot ||
        disk.mountId !== h.disk.mountId ||
        disk.stopped !== h.disk.stopped
      )
        throw Error(
          "The retained original source is neither sealed nor retired",
        );
    }
    this.sealedSource = {
      leaseSha256: hex(await sha256(h.lease)),
      previous: h.target,
    };
    try {
      return await action();
    } finally {
      this.sealedSource = null;
    }
  }

  private async completeReturn(h: Hold) {
    if (!h.reverseReturn)
      throw Error("Missing approved original image recovery");
    const ended = await this.reverse.request(
      h.stable,
      h.machineId,
      h.reverseReturn.lease,
      { op: "finish" },
    );
    if (
      ended.phase !== "finished" ||
      ended.revision !== h.reverseReturn.revision
    )
      throw Error("The projected original home is missing");
    await this.finishRetirement(h);
    return ended;
  }

  reverseControl(
    stable: string,
    machine: string,
    lease: string,
    request: ReverseRequest,
  ) {
    return this.serialized(async () => {
      let h = this.hold;
      if (h && (h.stable !== stable || h.machineId !== machine))
        throw Error("Another source owns this maintenance window");
      return this.withOriginal(h, async () => {
        if (!h) return this.reverse.request(stable, machine, lease, request);
        const authority = await jsonObject<{
          lease: string;
          sourceLeaseSha256?: string;
          previousImage?: string;
          previous?: string;
        }>(
          this.hooks.bucket,
          homePrefix(stable) + "work-folders/reverse-enrollment",
        );
        if (
          authority?.lease !== lease ||
          lease === h.lease ||
          authority.sourceLeaseSha256 !== this.sealedSource?.leaseSha256 ||
          authority.previous !== h.target ||
          !digest.test(authority.previousImage ?? "")
        )
          throw Error("Recovery not enrolled for this retained source");
        if (h.reverseReturn) {
          if (h.reverseReturn.lease !== lease)
            throw Error("Another return to the original image is pending");
          return this.completeReturn(h);
        }
        if (request.op !== "finish")
          return this.reverse.request(stable, machine, lease, request);
        const state = await this.reverse.request(stable, machine, lease, {
          op: "status",
        });
        if (
          state.phase !== "committed" ||
          !state.revision ||
          !(await this.selectedImage(
            {
              ...h,
              lease,
              image: authority.previousImage!,
              target: state.revision,
            },
            request.selection,
          ))
        )
          throw Error(
            "The original image and complete legacy projection must be selected",
          );
        h = { ...h, reverseReturn: { lease, revision: state.revision } };
        await this.write(h);
        return this.completeReturn(h);
      });
    });
  }
  async load() {
    this.hold = (await this.hooks.storage.get<Hold>(holding)) ?? null;
    await this.reverse.load();
  }
  closed() {
    return this.hold !== null || this.reverse.closed();
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queued.then(action, action);
    this.queued = next.catch(() => {});
    return next;
  }
  private async write(value: Hold | null) {
    if (value) await this.hooks.storage.put(holding, value);
    else await this.hooks.storage.delete(holding);
    this.hold = value;
  }
  private async command(op: string, lease: string) {
    const disk = this.hooks.disk();
    if (!disk?.running) throw Error("The original home disk is unavailable");
    return physical<FrozenDisk>(disk, freezeProgram, [
      JSON.stringify({ op, lease }),
    ]);
  }
  async mutation(
    request: Request,
    authenticated: () => boolean,
    normal: () => Promise<Response>,
  ) {
    return this.serialized(async () => {
      const h = this.hold;
      if (!authenticated())
        return new Response("Retired home writer", { status: 401 });
      if (this.reverse.closed()) {
        const path = new URL(request.url).pathname;
        const saving =
          request.method === "PUT" &&
          (path === "/manifest.json" ||
            path === "/archive/index.json" ||
            path.startsWith("/archive/blobs/") ||
            path.startsWith("/restore-points/"));
        if (!this.reverse.permitsFinalSave() || !saving)
          return new Response("Mounted home writes are held", { status: 423 });
      }
      if (!h)
        return request.headers.has("x-laterdog-frozen-save")
          ? new Response("Expired frozen save", { status: 409 })
          : normal();
      if (
        h.phase === "held" &&
        h.expiresAt > Date.now() &&
        request.method === "PUT" &&
        new URL(request.url).pathname === "/manifest.json" &&
        request.headers.get("x-laterdog-frozen-save") === h.lease
      ) {
        const disk = await this.command("status", h.lease);
        if (
          disk.phase !== "held" ||
          disk.boot !== h.disk?.boot ||
          disk.mountId !== h.disk.mountId
        )
          throw Error("Original disk freeze changed");
        const body = await request.arrayBuffer(),
          sha = hex(await sha256(new Uint8Array(body)));
        if (h.baselineManifest && h.baselineManifest !== sha)
          return new Response("The frozen snapshot is already sealed", {
            status: 409,
          });
        const parsed = JSON.parse(new TextDecoder().decode(body));
        if (parsed.version !== 1 || !Array.isArray(parsed.entries))
          return new Response("Invalid frozen snapshot", { status: 422 });
        await this.hooks.bucket.put(
          homePrefix(h.stable) + "manifest.json",
          body,
          { sha256: sha, httpMetadata: { contentType: "application/json" } },
        );
        await this.write({
          ...h,
          baselineManifest: sha,
          savedEntries: parsed.entries.length,
        });
        return new Response("Frozen manifest saved", { status: 201 });
      }
      return new Response("Original home writes are held", {
        status: 423,
        headers: { "retry-after": "5" },
      });
    });
  }
  async control(
    stable: string,
    machineId: string,
    lease: string,
    r: CutoverRequest,
  ) {
    if (this.reverse.closed() && r.op !== "status")
      throw Error("Mounted home migration is active");
    if (!digest.test(lease)) throw Error("Invalid cutover authorization");
    const prefix = homePrefix(stable) + "work-folders/";
    const permit = await jsonObject<{
      v: number;
      machineId: string;
      lease: string;
      image: string;
      expiresAt: number;
      retired?: boolean;
      retiredRevision?: string;
    }>(this.hooks.bucket, prefix + "cutover-enrollment");
    if (
      permit?.v === 1 &&
      permit.retired &&
      permit.lease === lease &&
      permit.machineId === machineId &&
      (r.op === "status" || r.op === "retire") &&
      digest.test(permit.retiredRevision ?? "")
    )
      return { phase: "retired", revision: permit.retiredRevision };
    if (
      !permit ||
      permit.retired ||
      permit.v !== 1 ||
      permit.lease !== lease ||
      permit.machineId !== machineId ||
      !digest.test(permit.image) ||
      !Number.isSafeInteger(permit.expiresAt) ||
      permit.expiresAt <= Date.now() ||
      permit.expiresAt > Date.now() + 86400_000
    )
      throw Error("No active cutover authorization");
    if (r.op === "snapshot") {
      const h = this.hold,
        c = this.hooks.disk();
      if (
        !h ||
        h.lease !== lease ||
        h.phase !== "held" ||
        !c?.running ||
        h.expiresAt <= Date.now()
      )
        throw Error("The original disk is not held");
      if (h.baselineManifest) {
        const saved = await this.hooks.bucket.get(
          homePrefix(stable) + "manifest.json",
        );
        if (!saved || (await sha256Stream(saved.body)) !== h.baselineManifest)
          throw Error("The acknowledged frozen snapshot has changed");
        return {
          sha256: h.baselineManifest,
          entries: h.savedEntries,
          uploaded: 0,
          reused: true,
        };
      }
      return physical<{ sha256: string; entries: number; uploaded: number }>(
        c,
        saveProgram,
        [lease],
      );
    }
    return this.serialized(async () => {
      if (this.reverse.closed() && r.op !== "status")
        throw Error("Mounted home migration is active");
      let h = this.hold;
      if (
        h &&
        (h.lease !== lease || h.machineId !== machineId || h.stable !== stable)
      )
        throw Error("Different original home freeze");
      if (r.op === "status") {
        const disk =
          h && this.hooks.disk()?.running
            ? await this.command("status", lease)
            : null;
        return {
          ...(h && {
            machineId: h.machineId,
            stable: h.stable,
            image: h.image,
            expiresAt: h.expiresAt,
            baselineManifest: h.baselineManifest,
            target: h.target,
            candidate: h.candidate,
          }),
          configuredImage: this.hooks.configuredImage(),
          phase: h?.phase ?? "open",
          disk,
          sourceDisk: disk ? this.hooks.physicalId + "/" + disk.boot : null,
        };
      }
      if (r.op === "begin" && !h) {
        h = {
          lease,
          machineId,
          stable,
          image: permit.image,
          phase: "arming",
          writerEpoch: await this.hooks.writerEpoch(),
          expiresAt: Date.now() + milliseconds,
        };
        await this.write(h);
        await this.hooks.schedule();
        try {
          if (!(await this.hooks.idle()))
            throw Error("Original home has active work");
          const disk = await this.command("begin", lease);
          if (disk.phase !== "held" || !disk.mountId || !disk.stopped)
            throw Error("Original home did not hold its writers");
          h = { ...h, disk, phase: "held" };
          await this.write(h);
        } catch (e) {
          await this.release(h);
          throw e;
        }
      }
      if (!h) {
        if (r.op === "abort") return { phase: "open" };
        throw Error("No original home freeze");
      }
      if (r.op === "begin" || r.op === "renew") {
        if (h.phase !== "held" || h.expiresAt <= Date.now())
          throw Error("The cutover lease expired");
        const disk = await this.command("renew", lease);
        if (
          disk.phase !== "held" ||
          disk.boot !== h.disk?.boot ||
          disk.mountId !== h.disk.mountId
        )
          throw Error("The original home disk changed");
        h = { ...h, disk, expiresAt: Date.now() + milliseconds };
        await this.write(h);
        await this.hooks.schedule();
        return {
          phase: h.phase,
          expiresAt: h.expiresAt,
          disk,
          sourceDisk: this.hooks.physicalId + "/" + disk.boot,
          baselineManifest: h.baselineManifest,
        };
      }
      if (r.op === "abort") {
        await this.release(h);
        return { phase: "open" };
      }
      if (r.op === "publish") return this.publish(h, r, prefix);
      if (r.op === "retire") {
        if (
          (h.phase !== "committed" && h.phase !== "retiring") ||
          !(await this.published(h))
        )
          throw Error("The new folder placement has not committed");
        if (
          h.phase !== "retiring" &&
          !(await this.selectedImage(h, r.selection))
        )
          throw Error("The replacement home image has not been selected");
        const retiring = { ...h, phase: "retiring" as const };
        await this.write(retiring);
        await this.hooks.schedule();
        return this.finishRetirement(retiring);
      }
      throw Error("Unsupported cutover operation");
    });
  }
  private async immutableJson(prefix: string, id: string) {
    const o = await this.hooks.bucket.get(prefix + id);
    if (!o) throw Error("Immutable restore evidence is missing");
    const b = new Uint8Array(await o.arrayBuffer());
    if (hex(await sha256(b)) !== id)
      throw Error("Immutable restore evidence was changed");
    return JSON.parse(new TextDecoder().decode(b));
  }
  private async selectedImage(h: Hold, selection?: string) {
    const configured = this.hooks.configuredImage();
    if (configured) return configured === h.image;
    if (!selection || !digest.test(selection)) return false;
    const obj = await this.hooks.bucket.get(
      homePrefix(h.stable) +
        "work-folders/cutover-image-selections/" +
        selection,
    );
    if (!obj) return false;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (hex(await sha256(bytes)) !== selection) return false;
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return (
      v.v === 1 &&
      v.stable === h.stable &&
      v.machineId === h.machineId &&
      v.lease === h.lease &&
      v.image === h.image &&
      v.placement === h.target &&
      typeof v.workerVersion === "string" &&
      /^[a-f0-9-]{36}$/.test(v.workerVersion) &&
      typeof v.applicationId === "string" &&
      /^[a-f0-9-]{36}$/.test(v.applicationId) &&
      Number.isSafeInteger(v.observedAt) &&
      v.observedAt <= Date.now() &&
      Date.now() - v.observedAt < 120_000
    );
  }
  private async finishRetirement(h: Hold) {
    const key = homePrefix(h.stable) + "work-folders/cutover-enrollment";
    let original = false;
    if (this.hooks.disk()?.running) {
      const disk = await this.command("status", h.lease);
      original = disk.boot === h.disk?.boot;
      if (original && disk.phase !== "sealed")
        throw Error("The original disk is no longer sealed");
    }
    const enrollment = await this.hooks.bucket.get(key);
    const enrolled = await enrollment?.json<{
      lease: string;
      retired?: boolean;
      retiredRevision?: string;
    }>();
    if (
      !enrollment ||
      enrolled?.lease !== h.lease ||
      (enrolled.retired && enrolled.retiredRevision !== h.target)
    )
      throw Error("Original enrollment changed before retirement");
    await this.hooks.retire(original);
    if (!enrolled.retired) {
      const recorded = await this.hooks.bucket.put(
        key,
        JSON.stringify({
          ...enrolled,
          retired: true,
          retiredRevision: h.target,
        }),
        { onlyIf: { etagMatches: enrollment.etag } },
      );
      if (!recorded) {
        const reread = await jsonObject<typeof enrolled>(
          this.hooks.bucket,
          key,
        );
        if (
          !reread?.retired ||
          reread.lease !== h.lease ||
          reread.retiredRevision !== h.target
        )
          throw Error("Original retirement receipt changed");
      }
    }
    await this.write(null);
    return { phase: "retired", revision: h.target };
  }
  async drain() {
    await this.queued;
  }
  private async publish(
    h: Hold,
    r: Extract<CutoverRequest, { op: "publish" }>,
    prefix: string,
  ) {
    const p = workFolderPlacementSchema.parse(r.placement);
    if (
      h.phase === "publishing" &&
      h.candidate === r.candidate &&
      h.publication?.raw === JSON.stringify(r.placement)
    )
      return this.applyPublication(h);
    if (
      h.phase === "committed" &&
      h.candidate === r.candidate &&
      (await this.published(h))
    )
      return { phase: "committed", revision: h.target };
    if (
      h.phase !== "held" ||
      h.expiresAt <= Date.now() ||
      !digest.test(r.candidate) ||
      !h.disk ||
      !h.baselineManifest ||
      p.mode !== "folders" ||
      h.baselineManifest !== p.baselineManifest
    )
      throw Error("Frozen snapshot and target placement differ");
    const expected = await this.hooks.bucket.get(
      prefix + "cutover-candidates/" + r.candidate,
    );
    if (!expected) throw Error("Restore-only candidate receipt is missing");
    const data = await expected.arrayBuffer();
    if (hex(await sha256(new Uint8Array(data))) !== r.candidate)
      throw Error("Restore-only candidate receipt changed");
    const c = JSON.parse(new TextDecoder().decode(data)),
      sourceDisk = this.hooks.physicalId + "/" + h.disk.boot;
    if (
      c.v !== 1 ||
      c.stable !== h.stable ||
      c.machineId !== h.machineId ||
      c.lease !== h.lease ||
      c.sourceBoot !== h.disk.boot ||
      c.sourceMountId !== h.disk.mountId ||
      c.sourceDisk !== sourceDisk ||
      typeof c.candidateDisk !== "string" ||
      !c.candidateDisk ||
      c.candidateDisk === sourceDisk ||
      c.image !== h.image ||
      c.baselineManifest !== h.baselineManifest ||
      c.verification !== p.verification ||
      c.restored !== true ||
      c.appStarted !== false
    )
      throw Error("Restore-only candidate does not verify this disk");
    const raw = JSON.stringify(r.placement),
      target = hex(await sha256(raw));
    const candidateIdentity =
      /^([a-f0-9]{64})\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([0-9]+)$/.exec(
        c.candidateDisk,
      );
    if (
      !candidateIdentity ||
      candidateIdentity[1] === this.hooks.physicalId ||
      candidateIdentity[2] === h.disk.boot ||
      !digest.test(c.restoreResult)
    )
      throw Error("Restore-only candidate does not verify an independent disk");
    const receipt = await this.immutableJson(
      prefix + "cutover-restore-results/",
      c.restoreResult,
    );
    if (
      receipt.state !== "verified" ||
      receipt.candidateDisk !== c.candidateDisk ||
      !digest.test(receipt.run) ||
      receipt.scopes !== (await layoutScopes(p.layout)).length
    )
      throw Error("Restore-only candidate readback does not verify all scopes");
    const run = await this.immutableJson(prefix + "cutover-runs/", receipt.run);
    if (
      run.v !== 1 ||
      run.stable !== h.stable ||
      run.image !== h.image ||
      run.verification !== p.verification ||
      run.baselineManifest !== p.baselineManifest ||
      run.placement !== target ||
      !digest.test(run.index)
    )
      throw Error("Restore-only candidate did not run against this release");
    const headers = new Headers(r.precondition);
    if (
      p.previous
        ? !/^"[^"]+"$/.test(headers.get("if-match") ?? "")
        : headers.get("if-none-match") !== "*"
    )
      throw Error("Missing placement precondition");
    const next = {
      ...h,
      phase: "publishing" as const,
      target,
      candidate: r.candidate,
      publication: { raw, precondition: Object.fromEntries(headers) },
    };
    await this.write(next);
    await this.hooks.schedule();
    return this.applyPublication(next);
  }
  private async committed(next: Hold) {
    await this.hooks.revokeWriter(next.writerEpoch);
    await this.write({ ...next, phase: "committed", publication: undefined });
    return { phase: "committed", revision: next.target };
  }
  private async applyPublication(next: Hold) {
    if (await this.published(next)) {
      return this.committed(next);
    }
    if (!next.publication || !next.disk)
      throw Error("Missing durable cutover publication");
    const h = next;
    const before = await this.command("status", h.lease);
    if (before.boot === next.disk.boot && before.phase === "open") {
      const old = await this.hooks.bucket.get(
        homePrefix(h.stable) + "work-folders/placement",
      );
      if (
        (old ? await sha256Stream(old.body) : null) ===
        JSON.parse(next.publication.raw).previous
      ) {
        await this.write(null);
        throw Error("The source lease expired before its disk was sealed");
      }
    }
    const disk = await this.command("seal", h.lease);
    if (
      disk.boot !== next.disk.boot ||
      disk.mountId !== next.disk.mountId ||
      disk.phase !== "sealed"
    )
      throw Error("Original home disk changed before activation");
    const response = await handleWorkFolderPlacement(
      new Request("https://state.r2/work-folders/placement", {
        method: "PUT",
        body: next.publication.raw,
        headers: next.publication.precondition,
      }),
      this.hooks.bucket,
      h.stable,
    );
    if (!response.ok) {
      if (
        [409, 422].includes(response.status) &&
        !(await this.published(next))
      ) {
        const current = await this.hooks.bucket.get(
          homePrefix(next.stable) + "work-folders/placement",
        );
        const previous = current ? await sha256Stream(current.body) : null;
        if (previous === JSON.parse(next.publication.raw).previous) {
          const held = {
            ...next,
            phase: "held" as const,
            target: undefined,
            publication: undefined,
          };
          await this.write(held);
          await this.release(held);
        }
      }
      throw Error("Cutover publication was not acknowledged");
    }
    if (!(await this.published(next)))
      throw Error("Cutover publication readback differed");
    return this.committed(next);
  }
  private async published(h: Hold) {
    const placed = await this.hooks.bucket.get(
      homePrefix(h.stable) + "work-folders/placement",
    );
    return Boolean(
      placed && h.target && (await sha256Stream(placed.body)) === h.target,
    );
  }
  private async release(h: Hold) {
    if (
      h.phase === "committed" ||
      h.phase === "retiring" ||
      h.phase === "publishing" ||
      (h.target && (await this.published(h)))
    )
      throw Error("A committed cutover cannot thaw the original home");
    if (this.hooks.disk()?.running) await this.command("abort", h.lease);
    await this.write(null);
  }
  async recover() {
    return this.serialized(async () => {
      const h = this.hold;
      if (this.reverse.closed() || h?.reverseReturn) {
        await this.withOriginal(h, async () => {
          if (h?.reverseReturn) await this.completeReturn(h);
          else await this.reverse.recover();
        });
        return;
      }
      if (!h) return;
      if (h.phase === "committed") return;
      await this.hooks.schedule();
      if (h.phase === "retiring") {
        if (!(await this.published(h)))
          throw Error("Committed placement changed during retirement");
        await this.finishRetirement(h);
        return;
      }
      if (h.phase === "publishing") {
        await this.applyPublication(h);
        return;
      }
      if (h.expiresAt <= Date.now()) await this.release(h);
    });
  }
}
