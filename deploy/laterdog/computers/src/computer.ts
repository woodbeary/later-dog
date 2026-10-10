// One dog's computer: a Durable Object that owns one container (the desktop image, or the snapshot it last slept as).
//
// The Durable Object is the computer's single source of truth. It keeps one record in its SQLite storage (name, size,
// state, boot generation, latest snapshot), starts and stops the container through ctx.container, runs commands with
// exec(), proxies the viewer's WebSocket to noVNC, and uses its alarm for two jobs: waiting for a fresh boot to become
// ready, then deciding when an idle computer should sleep (snapshot, then stop). It copies each change to the registry
// so the list endpoint stays one call.

import { DurableObject } from "cloudflare:workers";
import type { Refusal } from "./auth";
import { DESKTOP_LINK_TTL_SECONDS, signDesktopToken, verifyDesktopToken } from "./desktop-token";
import { type Collected, collect, json, outputText, within } from "./http";
import { type IdlePolicy, MINUTE, decideIdle, idlePolicy, inactivityTimeoutMs } from "./idle";
import { type ExecInput, FILE_MAX_BYTES, SIZES, type Size } from "./inputs";
import { route } from "./routes";
import { trialPolicy } from "./trial";
import { trials } from "./trial-registry";
import { messagePage, newNonce, pageHeaders, viewerPage } from "./viewer";

export type State = "starting" | "running" | "sleeping" | "stopping" | "error";

export interface ComputerView {
  id: string;
  name: string;
  size: Size;
  state: State;
  createdAt: string;
  lastActiveAt: string;
  snapshotAt?: string;
  /** Why the computer is in the "error" state. */
  error?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

interface ComputerRecord {
  id: string;
  name: string;
  size: Size;
  state: State;
  createdAt: number;
  lastActiveAt: number;
  /** Boot count. Desktop links are signed over it, so every wake retires the links issued before. */
  generation: number;
  /** When the current boot started (for MAX_AWAKE_HOURS). */
  awakeSince?: number;
  /** The latest snapshot handle; the Worker API cannot list snapshots, so this is the only record of it. */
  snapshot?: { id: string; size: number; name?: string };
  snapshotAt?: number;
  /** The image this computer was first started from. Its snapshots only restore onto that image's filesystem. */
  image?: string;
  error?: string;
  registry?: string;
  trial?: string;
  budgetEndsAt?: number;
  chargedUntil?: number;
  unchargedMs?: number;
}

const RECORD = "computer";
const DESKTOP_PORT = 6080;
const DOG = "1000:1000";
const DOG_HOME = "/home/dog";
// exec() passes only these (and PATH) to a command; nothing from the image or start() is inherited.
const DOG_ENV: Record<string, string> = {
  HOME: DOG_HOME,
  USER: "dog",
  LOGNAME: "dog",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  TZ: "UTC",
  DISPLAY: ":0",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  NO_AT_BRIDGE: "1",
};
const BOOT_TIMEOUT_MS = 5 * MINUTE;
const READY_POLL_MS = 1000;
const STOPPED_GRACE_MS = 30_000;
const EXEC_OUTPUT_CAP = 1024 * 1024;
const ACTIVITY_WRITE_MS = 30_000;
const BUDGET_GRACE_MS = 10 * MINUTE;

// Readiness: the display answers xdotool and the VNC server behind websockify sends its RFB greeting (exit 3 when only
// that much is up), then XFCE has drawn its panel and desktop (exit 0). The VNC server answers about a second before
// XFCE draws, so without the second half a screenshot or click right after "running" hit a black screen.
const READY_SCRIPT = [
  `xdotool getdisplaygeometry >/dev/null || exit 1`,
  `exec 3<>/dev/tcp/127.0.0.1/5900 && head -c 12 <&3 | grep -q '^RFB ' || exit 1`,
  `xdotool search --onlyvisible --class '^xfce4-panel$' >/dev/null && xdotool search --onlyvisible --class '^xfdesktop$' >/dev/null || exit 3`,
].join("\n");
// A dog may change its own desktop session so the panel or desktop never appears; it still gets a usable computer.
const DESKTOP_GRACE_MS = 30_000;
// File transfer. The path arrives as $1, never inside the script text. Exit codes 44-48 are mapped to API errors.
const READ_SCRIPT = `f=$1; [ -f "$f" ] || exit 44; size=$(stat -c %s -- "$f") || exit 1; [ "$size" -le ${FILE_MAX_BYTES} ] || exit 45; exec cat -- "$f"`;
const WRITE_SCRIPT = `f=$1; [ ! -d "$f" ] || exit 48; mkdir -p -- "$(dirname -- "$f")" || exit 47; cat > "$f"`;
// One JPEG of the whole screen with the pointer drawn in.
const SCREENSHOT_SCRIPT = `f=$(mktemp --suffix=.jpg) || exit 1; trap 'rm -f "$f"' EXIT; scrot --overwrite --pointer --quality 75 "$f" >/dev/null && cat -- "$f"`;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: number, code: string, message: string): Result<never> => ({ ok: false, refusal: { status, code, message } });
const notFound = () => fail(404, "not_found", "No computer with that id.");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const iso = (ms: number) => new Date(ms).toISOString();

function view(record: ComputerRecord): ComputerView {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    state: record.state,
    createdAt: iso(record.createdAt),
    lastActiveAt: iso(record.lastActiveAt),
    ...(record.snapshotAt === undefined ? {} : { snapshotAt: iso(record.snapshotAt) }),
    ...(record.state === "error" && record.error ? { error: record.error } : {}),
  };
}

function closeQuietly(socket: WebSocket, code: number, reason: string): void {
  // Only 1000 and 3000-4999 may be sent; 1005/1006 describe a close that carried no code.
  const sendable = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
  try {
    socket.close(sendable, reason.slice(0, 120));
  } catch {
    // Already closed.
  }
}

interface RunOptions {
  timeoutMs: number;
  /** Bytes of stdout to keep. */
  cap: number;
  /** uid:gid; omitted runs as root. */
  user?: string;
  cwd?: string;
  stdin?: ReadableStream;
}

interface RunResult {
  exitCode: number;
  stdout: Collected;
  stderr: Collected;
  timedOut: boolean;
}

export class DogComputer extends DurableObject<Env> {
  private readonly policy = idlePolicy(this.env);
  private readonly trialIdle: IdlePolicy = { ...idlePolicy(this.env), idleSleepMs: trialPolicy(this.env).idleSleepMs };
  /** Open viewer sockets (browser side) and the noVNC socket each one is paired with. */
  private readonly viewers = new Map<WebSocket, WebSocket>();
  private inFlight = 0;
  /**
   * True while remove() runs. Requests that interleave with it (a viewer asks for its link's status the moment remove()
   * closes it) see no computer, and reconcile() does not mistake the deliberate stop for a crash.
   */
  private deleting = false;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private lastActivityWrite = 0;
  private lastPublished = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A restarted Durable Object (after a deploy, for one) starts without the inactivity timeout; without it the platform
    // stops the container soon after this object goes quiet, before the idle alarm could snapshot it.
    const container = ctx.container;
    if (container?.running) {
      const timeoutMs = inactivityTimeoutMs(this.policyFor(this.load()));
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(timeoutMs);
        } catch (error) {
          console.error(`laterdog computers: could not re-arm the inactivity timeout: ${describeError(error)}`);
        }
      });
    }
  }

  // ---- API (called by the Worker over RPC) ----

  async init(input: { id: string; name: string; size: Size; registry?: string; trial?: string }): Promise<Result<ComputerView>> {
    return this.serially(async () => {
      const existing = this.load();
      if (existing) return ok(view(existing));
      const now = Date.now();
      this.save({
        id: input.id,
        name: input.name,
        size: input.size,
        state: "starting",
        createdAt: now,
        lastActiveAt: now,
        generation: 0,
        ...(input.registry === undefined ? {} : { registry: input.registry }),
        ...(input.trial === undefined ? {} : { trial: input.trial }),
      });
      const booted = await this.boot();
      return booted.ok ? ok(view(this.load()!)) : booted;
    });
  }

  async describe(): Promise<Result<ComputerView>> {
    if (!this.load() || this.deleting) return notFound();
    await this.reconcile();
    const current = this.load();
    return current && !this.deleting ? ok(view(current)) : notFound();
  }

  async rename(name: string): Promise<Result<ComputerView>> {
    const record = this.update((r) => {
      r.name = name;
    });
    if (!record) return notFound();
    await this.publish();
    return ok(view(record));
  }

  /** Starts the computer from its latest snapshot (or the image, if it never slept). Returns at once with state "starting". */
  async wake(): Promise<Result<ComputerView>> {
    return this.serially(async () => {
      const record = this.load();
      if (!record) return notFound();
      if ((record.state === "running" || record.state === "starting") && this.ctx.container?.running) {
        return ok(view(this.markActive()!));
      }
      const booted = await this.boot();
      return booted.ok ? ok(view(this.load()!)) : booted;
    });
  }

  /** Snapshots the whole filesystem, then stops the container. A failed snapshot leaves it running and says so. */
  async sleep(reason: "request" | "idle" | "max_awake" | "budget" = "request"): Promise<Result<ComputerView>> {
    return this.serially(async () => {
      const record = this.load();
      if (!record) return notFound();
      if (record.state === "sleeping") return ok(view(record));
      const container = this.container();
      const previous = record.state;
      this.update((r) => {
        r.state = "stopping";
      });
      this.closeViewers(4001, "The computer went to sleep.");
      await this.publish();
      if (container.running) {
        // Push written data to disk so the snapshot holds what programs think they saved.
        await this.run(["sync"], { timeoutMs: 30_000, cap: 1024 }).catch(() => undefined);
        const started = Date.now();
        let snapshot: ContainerSnapshot;
        try {
          snapshot = await container.snapshotContainer({ name: `${record.id}-g${record.generation}` });
        } catch (error) {
          const restored = this.update((r) => {
            r.state = previous === "stopping" ? "running" : previous;
          })!;
          // Keep the alarm going: a booting computer still needs its readiness check; an idle one tries again later.
          await this.ctx.storage.setAlarm(Date.now() + (restored.state === "starting" ? READY_POLL_MS : 5 * MINUTE));
          await this.publish();
          console.error(`laterdog computers: ${record.id} snapshot failed (${reason}): ${describeError(error)}`);
          return fail(502, "snapshot_failed", `The snapshot failed, so the computer was left running: ${describeError(error)}`);
        }
        console.log(`laterdog computers: ${record.id} snapshot ${snapshot.id} of ${snapshot.size} bytes took ${Date.now() - started} ms (${reason})`);
        this.update((r) => {
          r.snapshot = { id: snapshot.id, size: snapshot.size, ...(snapshot.name ? { name: snapshot.name } : {}) };
          r.snapshotAt = Date.now();
        });
        try {
          await container.destroy();
        } catch (error) {
          console.error(`laterdog computers: ${record.id} stop after snapshot failed: ${describeError(error)}`);
        }
      }
      await this.charge(true);
      const slept = this.update((r) => {
        r.state = "sleeping";
        delete r.awakeSince;
        delete r.error;
      })!;
      await this.ctx.storage.deleteAlarm();
      await this.publish();
      return ok(view(slept));
    });
  }

  /** Destroys the container and forgets the computer. Its snapshot cannot be deleted through the API and expires in 30 days. */
  async remove(): Promise<Result<{ deleted: true }>> {
    return this.serially(async () => {
      const record = this.load();
      if (!record) return notFound();
      this.deleting = true;
      try {
        this.closeViewers(4002, "The computer was deleted.");
        const container = this.container();
        if (container.running) await container.destroy();
        await this.charge(true);
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      } finally {
        this.deleting = false;
      }
      console.log(`laterdog computers: ${record.id} deleted`);
      return ok({ deleted: true as const });
    });
  }

  async meter(): Promise<void> {
    await this.charge();
  }

  async exec(input: ExecInput): Promise<Result<ExecResult>> {
    return this.using(async () => {
      const result = await this.run(["bash", "-lc", input.command], { timeoutMs: input.timeoutMs, cap: EXEC_OUTPUT_CAP, user: DOG, cwd: input.cwd ?? DOG_HOME });
      return ok({ exitCode: result.exitCode, stdout: outputText(result.stdout), stderr: outputText(result.stderr), timedOut: result.timedOut });
    });
  }

  async readFile(path: string): Promise<Result<Uint8Array>> {
    return this.using(async () => {
      const result = await this.run(["bash", "-c", READ_SCRIPT, "laterdog-read", path], { timeoutMs: 60_000, cap: FILE_MAX_BYTES + 1, user: DOG, cwd: DOG_HOME });
      if (result.exitCode === 44) return fail(404, "file_not_found", `No file at ${path}.`);
      if (result.exitCode === 45 || result.stdout.total > FILE_MAX_BYTES) return fail(413, "too_large", `The file is larger than ${FILE_MAX_BYTES} bytes.`);
      if (result.exitCode !== 0) return fail(502, "read_failed", `Reading ${path} failed: ${outputText(result.stderr).trim() || `exit ${result.exitCode}`}`);
      return ok(result.stdout.bytes);
    });
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<Result<{ ok: true }>> {
    return this.using(async () => {
      const stdin = new Blob([bytes]).stream();
      const result = await this.run(["bash", "-c", WRITE_SCRIPT, "laterdog-write", path], { timeoutMs: 60_000, cap: 4096, user: DOG, cwd: DOG_HOME, stdin });
      if (result.exitCode === 48) return fail(409, "is_directory", `${path} is a directory.`);
      if (result.exitCode === 47) return fail(409, "invalid_parent", `Could not create the folders for ${path}: ${outputText(result.stderr).trim()}`);
      if (result.exitCode !== 0) return fail(502, "write_failed", `Writing ${path} failed: ${outputText(result.stderr).trim() || `exit ${result.exitCode}`}`);
      return ok({ ok: true as const });
    });
  }

  async screenshot(): Promise<Result<Uint8Array>> {
    return this.using(async () => {
      const result = await this.run(["bash", "-c", SCREENSHOT_SCRIPT], { timeoutMs: 20_000, cap: FILE_MAX_BYTES, user: DOG, cwd: DOG_HOME });
      if (result.exitCode !== 0 || result.stdout.bytes.byteLength === 0) {
        return fail(502, "screenshot_failed", `The screenshot failed: ${outputText(result.stderr).trim() || `exit ${result.exitCode}`}`);
      }
      return ok(result.stdout.bytes);
    });
  }

  /** A signed viewer link for the current boot, valid for two hours or until the computer sleeps. */
  async desktopLink(origin: string): Promise<Result<{ url: string; expiresAt: string }>> {
    const secret = this.env.DESKTOP_SIGNING_KEY;
    if (!secret) return fail(503, "not_configured", "The DESKTOP_SIGNING_KEY secret is not set on this Worker.");
    return this.using(async (record) => {
      const expiresAt = Math.floor(Date.now() / 1000) + DESKTOP_LINK_TTL_SECONDS;
      const token = await signDesktopToken(secret, record.id, record.generation, expiresAt);
      return ok({ url: `${origin}/desktop/${record.id}/${token}/`, expiresAt: iso(expiresAt * 1000) });
    });
  }

  // ---- Viewer traffic (the Worker forwards /desktop/<id>/<token>/... here unchanged) ----

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = route(request.method, url.pathname);
    if (target.kind !== "desktop") return new Response("Not found", { status: 404 });
    const nonce = newNonce();
    const page = (status: number, title: string, message: string) =>
      new Response(messagePage({ title, message, nonce }), { status, headers: pageHeaders(url, nonce) });
    const gone = () => page(404, "No such computer", "This computer does not exist any more.");
    const record = this.load();
    if (!record || this.deleting || record.id !== target.id) return gone();
    const secret = this.env.DESKTOP_SIGNING_KEY;
    if (!secret) return page(503, "Not configured", "The DESKTOP_SIGNING_KEY secret is not set on this Worker.");
    const verdict = await verifyDesktopToken(secret, record.id, record.generation, target.token, Math.floor(Date.now() / 1000));
    if (verdict !== "valid") {
      const title = verdict === "expired" ? "This link has expired" : "This link has ended";
      if (target.resource.type !== "page") return json({ error: { code: `link_${verdict}`, message: title } }, 403);
      return page(403, title, "Desktop links last two hours and end when the computer sleeps. Open the desktop again from later.dog.");
    }
    await this.reconcile();
    // The computer may have been deleted while this request waited.
    const current = this.load();
    if (!current || this.deleting) return gone();
    const awake = current.state === "running" && this.ctx.container?.running === true;
    switch (target.resource.type) {
      case "status":
        return json({ state: current.state, name: current.name });
      case "page": {
        if (!awake) return page(409, "The computer is asleep", "Wake it from later.dog, then open the desktop again.");
        this.markActive();
        const expiresAtMs = Number(target.token.split(".")[0]) * 1000;
        return new Response(viewerPage({ name: current.name, expiresAtMs, nonce }), { headers: pageHeaders(url, nonce) });
      }
      case "asset":
        if (!awake) return new Response("The computer is asleep.", { status: 409 });
        return this.proxyAsset(target.resource.path);
      case "socket":
        if (!awake) return new Response("The computer is asleep.", { status: 409 });
        return this.openViewer(request, url);
    }
  }

  private async proxyAsset(path: string): Promise<Response> {
    const upstream = await this.container().getTcpPort(DESKTOP_PORT).fetch(`http://container/${path}`);
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });
    }
    // Only noVNC's .js modules are routed here (routes.ts), so the type is known; they never change within a boot.
    return new Response(upstream.body, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
    });
  }

  /**
   * Bridges the browser's WebSocket to websockify inside the container. Both ends terminate here (rather than passing the
   * container's socket straight through) so this object knows when a viewer is open, which keeps the computer awake.
   */
  private async openViewer(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426, headers: { upgrade: "websocket" } });
    }
    // Browsers send Origin on WebSocket requests: only this Worker's own viewer page may open one.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return new Response("Cross-origin viewers are refused.", { status: 403 });
    let upstream: WebSocket | null;
    try {
      const response = await this.container().getTcpPort(DESKTOP_PORT).fetch("http://container/websockify", { headers: { upgrade: "websocket" } });
      upstream = response.webSocket;
    } catch (error) {
      console.error(`laterdog computers: viewer connection to websockify failed: ${describeError(error)}`);
      return new Response("The desktop did not answer.", { status: 502 });
    }
    if (!upstream) return new Response("The desktop refused the connection.", { status: 502 });
    // VNC is binary. Since compatibility date 2026-03-17 a Worker WebSocket delivers binary frames as Blobs unless told
    // otherwise, and send(blob) forwards the text "[object Blob]", so both ends must ask for ArrayBuffers before accept().
    upstream.binaryType = "arraybuffer";
    upstream.accept();
    const pair = new WebSocketPair();
    const [client, browser] = [pair[0], pair[1]];
    browser.binaryType = "arraybuffer";
    browser.accept();
    this.viewers.set(browser, upstream);
    this.markActive();
    const drop = () => {
      if (this.viewers.delete(browser)) this.markActive();
    };
    browser.addEventListener("message", (event) => {
      this.noteViewerActivity();
      try {
        upstream.send(event.data);
      } catch {
        // The desktop side is closing.
      }
    });
    upstream.addEventListener("message", (event) => {
      try {
        browser.send(event.data);
      } catch {
        // The viewer is closing.
      }
    });
    browser.addEventListener("close", (event) => {
      closeQuietly(upstream, event.code, event.reason);
      drop();
    });
    upstream.addEventListener("close", (event) => {
      closeQuietly(browser, event.code, event.reason);
      drop();
    });
    browser.addEventListener("error", () => {
      closeQuietly(upstream, 1011, "viewer error");
      drop();
    });
    upstream.addEventListener("error", () => {
      closeQuietly(browser, 1011, "desktop error");
      drop();
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private closeViewers(code: number, reason: string): void {
    for (const [browser, upstream] of this.viewers) {
      closeQuietly(browser, code, reason);
      closeQuietly(upstream, 1000, reason);
    }
    this.viewers.clear();
  }

  // ---- Alarm: readiness after a boot, then the idle policy ----

  override async alarm(): Promise<void> {
    const record = this.load();
    if (!record) return;
    try {
      if (record.state === "starting") await this.awaitReady(record.generation);
      else if (record.state === "running") await this.watch();
      else if (record.state === "stopping") await this.sleep("idle");
    } catch (error) {
      console.error(`laterdog computers: alarm for ${record.id} failed: ${describeError(error)}`);
      if (this.load()) await this.ctx.storage.setAlarm(Date.now() + MINUTE);
    }
  }

  private async awaitReady(generation: number): Promise<void> {
    const container = this.container();
    const begun = this.load()?.awakeSince ?? Date.now();
    let displaySince: number | undefined;
    for (;;) {
      const record = this.load();
      if (!record || this.deleting || record.generation !== generation || record.state !== "starting") return;
      const elapsed = Date.now() - begun;
      if (elapsed > BOOT_TIMEOUT_MS) return this.failBoot(generation, `The desktop did not become ready within ${BOOT_TIMEOUT_MS / MINUTE} minutes.`);
      if (!container.running && elapsed > STOPPED_GRACE_MS) {
        return this.failBoot(generation, record.snapshot ? "The computer stopped while restoring its snapshot." : "The computer stopped while starting.");
      }
      const readiness = container.running ? await this.ready() : "none";
      if (readiness === "display") displaySince ??= Date.now();
      const withoutDesktop = readiness === "display" && Date.now() - displaySince! >= DESKTOP_GRACE_MS;
      if (readiness === "desktop" || withoutDesktop) {
        const now = Date.now();
        const ready = this.update((r) => {
          if (r.generation === generation && r.state === "starting") {
            r.state = "running";
            r.lastActiveAt = now;
          }
        });
        if (ready?.state === "running" && ready.generation === generation) {
          const how = `${ready.snapshot ? "from snapshot" : "from image"}${withoutDesktop ? "; its desktop session never drew" : ""}`;
          console.log(`laterdog computers: ${ready.id} ready ${now - begun} ms after start (generation ${generation}, ${how})`);
          await this.publish();
          await this.scheduleWatch();
        }
        return;
      }
      await sleep(READY_POLL_MS);
    }
  }

  /** "desktop" once XFCE has drawn; "display" while only the display and the VNC server answer. */
  private async ready(): Promise<"desktop" | "display" | "none"> {
    const container = this.container();
    try {
      const response = await within(container.getTcpPort(DESKTOP_PORT).fetch("http://container/defaults.json"), 3_000);
      await response?.body?.cancel();
      if (!response?.ok) return "none";
      const result = await this.run(["bash", "-c", READY_SCRIPT], { timeoutMs: 5_000, cap: 1024, user: DOG });
      return result.exitCode === 0 ? "desktop" : result.exitCode === 3 ? "display" : "none";
    } catch {
      return "none";
    }
  }

  private async failBoot(generation: number, why: string): Promise<void> {
    const failed = this.update((r) => {
      if (r.generation === generation && r.state === "starting") {
        r.state = "error";
        r.error = why;
      }
    });
    console.error(`laterdog computers: ${failed?.id} failed to boot: ${why}`);
    // Do not leave a broken container running up a bill.
    if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined);
    await this.charge(true);
    await this.publish();
  }

  private async watch(): Promise<void> {
    if (await this.reconcile()) return;
    await this.charge();
    const record = this.load();
    if (!record || record.state !== "running") return;
    const decision = this.idleDecision(record);
    if (!decision.sleep) {
      await this.ctx.storage.setAlarm(decision.checkAt);
      return;
    }
    console.log(`laterdog computers: ${record.id} is going to sleep (${decision.reason})`);
    const slept = await this.sleep(decision.reason);
    if (slept.ok) return;
    const overdue = decision.reason === "budget" && Date.now() - (record.budgetEndsAt ?? Date.now()) >= BUDGET_GRACE_MS;
    if (overdue) await this.stopUnsaved("This free trial ran out of minutes and the computer could not be saved, so it was stopped.");
    else await this.ctx.storage.setAlarm(Date.now() + 5 * MINUTE);
  }

  private idleDecision(record: ComputerRecord) {
    return decideIdle({
      ...this.policyFor(record),
      now: Date.now(),
      lastActiveAt: record.lastActiveAt,
      awakeSince: record.awakeSince ?? record.lastActiveAt,
      viewers: this.viewers.size,
      inFlight: this.inFlight,
      ...(record.budgetEndsAt === undefined ? {} : { budgetEndsAt: record.budgetEndsAt }),
    });
  }

  private policyFor(record: ComputerRecord | undefined): IdlePolicy {
    return record?.trial ? this.trialIdle : this.policy;
  }

  private async scheduleWatch(): Promise<void> {
    const record = this.load();
    if (!record || record.state !== "running") return;
    const decision = this.idleDecision(record);
    await this.ctx.storage.setAlarm(decision.sleep ? Date.now() : decision.checkAt);
  }

  /**
   * Notices a container that stopped behind the record's back (a host restart, the platform's inactivity timeout, the
   * desktop's main process exiting). Returns true when it changed the record.
   */
  private async reconcile(): Promise<boolean> {
    const record = this.load();
    if (!record || this.deleting || record.state !== "running" || this.ctx.container?.running) return false;
    this.update((r) => {
      r.state = "error";
      r.error = "The computer stopped unexpectedly, so changes since it last went to sleep are gone. Wake it to start again from its last snapshot.";
    });
    this.closeViewers(4003, "The computer stopped.");
    console.error(`laterdog computers: ${record.id} stopped unexpectedly`);
    await this.charge(true);
    await this.publish();
    return true;
  }

  private async budget(): Promise<Result<number | undefined>> {
    const record = this.load();
    if (!record?.trial) return ok(undefined);
    await this.charge(true);
    let left: number | null;
    try {
      left = await trials(this.env).budgetLeft(record.trial);
    } catch (error) {
      console.error(`laterdog computers: ${record.id} could not read its trial: ${describeError(error)}`);
      return fail(503, "trial_unavailable", "The free trial could not be checked. Try again in a minute.");
    }
    if (left === null) return fail(409, "trial_ended", "This free trial has ended.");
    const usable = left - (this.load()?.unchargedMs ?? 0);
    if (usable < MINUTE) return fail(409, "trial_used_up", "This free trial has no minutes left.");
    return ok(usable);
  }

  private async charge(stop = false): Promise<void> {
    if (!this.load()?.trial) return;
    const now = Date.now();
    let ms = 0;
    const record = this.update((r) => {
      if (r.chargedUntil !== undefined) {
        ms = Math.max(0, now - r.chargedUntil);
        r.chargedUntil = now;
      }
      ms += r.unchargedMs ?? 0;
      delete r.unchargedMs;
      if (stop) {
        delete r.chargedUntil;
        delete r.budgetEndsAt;
      }
    })!;
    if (ms <= 0) return;
    try {
      await trials(this.env).charge(record.trial!, ms);
    } catch (error) {
      this.update((r) => {
        r.unchargedMs = (r.unchargedMs ?? 0) + ms;
      });
      console.error(`laterdog computers: ${record.id} could not charge its trial: ${describeError(error)}`);
    }
  }

  private async stopUnsaved(why: string): Promise<void> {
    await this.serially(async () => {
      this.closeViewers(4001, "The computer was stopped.");
      if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => undefined);
      await this.charge(true);
      const stopped = this.update((r) => {
        r.state = "error";
        r.error = why;
        delete r.awakeSince;
      });
      if (!stopped) return;
      console.error(`laterdog computers: ${stopped.id} stopped without a snapshot: ${why}`);
      await this.ctx.storage.deleteAlarm();
      await this.publish();
    });
  }

  // ---- Helpers ----

  private async boot(): Promise<Result<void>> {
    const container = this.container();
    if (container.running) {
      // A container the record no longer trusts (one that never became ready, say): start over cleanly.
      await container.destroy().catch((error) => console.error(`laterdog computers: clearing the old container failed: ${describeError(error)}`));
    }
    const budget = await this.budget();
    if (!budget.ok) return budget;
    const now = Date.now();
    const record = this.update((r) => {
      r.generation += 1;
      r.state = "starting";
      r.awakeSince = now;
      r.lastActiveAt = now;
      delete r.error;
      if (budget.value !== undefined) {
        r.budgetEndsAt = now + budget.value;
        r.chargedUntil = now;
      }
    })!;
    const common = {
      enableInternet: true,
      instance: SIZES[record.size],
      env: { LATERDOG_COMPUTER_ID: record.id },
      labels: { computer: record.id, generation: String(record.generation) },
    };
    try {
      if (record.snapshot) {
        container.start({ ...common, containerSnapshot: { id: record.snapshot.id } });
      } else {
        const image = container.images.desktop;
        if (!image) throw new Error('No "desktop" image is configured for this Worker.');
        container.start({ ...common, image });
        this.update((r) => {
          r.image = image;
        });
      }
    } catch (error) {
      const why = `The computer could not start: ${describeError(error)}`;
      this.update((r) => {
        r.state = "error";
        r.error = why;
      });
      await this.charge(true);
      await this.publish();
      return fail(502, "start_failed", why);
    }
    try {
      await container.setInactivityTimeout(inactivityTimeoutMs(this.policyFor(record)));
    } catch (error) {
      console.error(`laterdog computers: ${record.id} could not set the inactivity timeout: ${describeError(error)}`);
    }
    console.log(
      `laterdog computers: ${record.id} starting (generation ${record.generation}, ${SIZES[record.size]}, ${record.snapshot ? `snapshot ${record.snapshot.id}` : "fresh image"}); running=${container.running}`,
    );
    await this.ctx.storage.setAlarm(Date.now() + READY_POLL_MS);
    await this.publish();
    return ok(undefined);
  }

  /** Runs an API operation that needs the desktop up, counting it as activity and as work in flight. */
  private async using<T>(work: (record: ComputerRecord) => Promise<Result<T>>): Promise<Result<T>> {
    const record = this.load();
    if (!record || this.deleting) return notFound();
    if (record.state !== "running" || !this.ctx.container?.running) {
      await this.reconcile();
      const current = this.load() ?? record;
      const hint = current.state === "starting" ? "it is still starting; try again shortly" : `it is ${current.state}; wake it first`;
      return fail(409, "asleep", `The computer is not running (${hint}).`);
    }
    this.inFlight += 1;
    this.markActive();
    try {
      return await work(record);
    } catch (error) {
      await this.reconcile();
      if (this.load()?.state !== "running") return fail(409, "asleep", "The computer stopped while the request was running.");
      console.error(`laterdog computers: ${record.id} operation failed: ${describeError(error)}`);
      return fail(502, "container_error", describeError(error));
    } finally {
      this.inFlight -= 1;
      this.markActive();
      if (Date.now() - this.lastPublished > MINUTE) await this.publish();
    }
  }

  /**
   * Runs a command in the container under GNU timeout (which also kills what the command started), draining its output as
   * it arrives. exec() itself has no timeout, so the process is only killed from here as a last resort and only while it
   * still runs: the runtime faults if a finished process is signalled.
   */
  private async run(argv: string[], options: RunOptions): Promise<RunResult> {
    const started = Date.now();
    const child = await this.container().exec(["timeout", "--kill-after=5", `${(options.timeoutMs / 1000).toFixed(3)}s`, ...argv], {
      env: DOG_ENV,
      ...(options.user ? { user: options.user } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.stdin ? { stdin: options.stdin } : {}),
    });
    let exited = false;
    const exit = child.exitCode.finally(() => {
      exited = true;
    });
    exit.catch(() => undefined);
    const stdout = collect(child.stdout as ReadableStream<Uint8Array> | null, options.cap);
    const stderr = collect(child.stderr as ReadableStream<Uint8Array> | null, EXEC_OUTPUT_CAP);
    let exitCode = await within(exit, options.timeoutMs + 10_000);
    if (exitCode === undefined) {
      if (!exited) {
        try {
          child.kill(9);
        } catch {
          // It finished in the meantime.
        }
      }
      exitCode = (await within(exit, 5_000)) ?? -1;
    }
    // A detached child that kept the pipes open is not waited for beyond a short grace period.
    const [out, err] = await Promise.all([stdout.settle(2_000), stderr.settle(2_000)]);
    return { exitCode, stdout: out, stderr: err, timedOut: (exitCode === 124 || exitCode === 137) && Date.now() - started >= options.timeoutMs };
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("This Durable Object has no container; check the containers entry in wrangler.jsonc.");
    return container;
  }

  private load(): ComputerRecord | undefined {
    return this.ctx.storage.kv.get<ComputerRecord>(RECORD);
  }

  private save(record: ComputerRecord): void {
    this.ctx.storage.kv.put(RECORD, record);
  }

  /** Read-modify-write with no await in between, so concurrent requests never overwrite each other's changes. */
  private update(mutate: (record: ComputerRecord) => void): ComputerRecord | undefined {
    const record = this.load();
    if (!record) return undefined;
    mutate(record);
    this.save(record);
    return record;
  }

  private markActive(): ComputerRecord | undefined {
    const now = Date.now();
    this.lastActivityWrite = now;
    return this.update((r) => {
      r.lastActiveAt = now;
    });
  }

  /** Viewer traffic counts as activity; written at most every 30 seconds. */
  private noteViewerActivity(): void {
    if (Date.now() - this.lastActivityWrite >= ACTIVITY_WRITE_MS) this.markActive();
  }

  /** Lifecycle changes (create, wake, sleep, delete) run one at a time. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(work, work);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /** Copies this computer's summary into the registry (best effort: the computer itself stays the source of truth). */
  private async publish(): Promise<void> {
    const record = this.load();
    if (!record) return;
    this.lastPublished = Date.now();
    try {
      await this.env.REGISTRY.get(this.env.REGISTRY.idFromName(record.registry ?? "registry")).update(view(record));
    } catch (error) {
      console.error(`laterdog computers: registry update for ${record.id} failed: ${describeError(error)}`);
    }
  }
}
