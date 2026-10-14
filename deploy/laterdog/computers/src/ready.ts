import { within } from "./http";

export const READY_POLL_MS = 250;
export const RFB_PROBE_MS = 1_500;
export const DESKTOP_GRACE_MS = 30_000;
export const PAINT_GRACE_MS = 3_000;
export const DESKTOP_DRAWN = 0;
export const DESKTOP_WINDOWS_MISSING = 3;
export const DESKTOP_UNPAINTED = 4;

export const DESKTOP_SCRIPT = [
  `read -r width height < <(xdotool getdisplaygeometry) || exit 1`,
  `painted() { local file size; file=$(mktemp --suffix=.png) || return 1; scrot --overwrite --autoselect "$1" "$file" >/dev/null 2>&1; size=$(stat -c %s -- "$file" 2>/dev/null || echo 0); rm -f -- "$file"; [ "$size" -gt "$2" ]; }`,
  `panels=$(xdotool search --onlyvisible --class '^xfce4-panel$') && [ -n "$panels" ] || exit ${DESKTOP_WINDOWS_MISSING}`,
  `xdotool search --onlyvisible --class '^xfdesktop$' >/dev/null || exit ${DESKTOP_WINDOWS_MISSING}`,
  `panel_painted=1`,
  `for id in $panels; do eval "$(xdotool getwindowgeometry --shell "$id")"; painted "$X,$Y,$WIDTH,$HEIGHT" 400 && panel_painted=0; done`,
  `[ "$panel_painted" = 0 ] || exit ${DESKTOP_UNPAINTED}`,
  `painted "$((width / 4)),$((height / 4)),$((width / 2)),$((height / 2))" 1500 || exit ${DESKTOP_UNPAINTED}`,
].join("\n");

export type Desktop = "drawn" | "unpainted" | "missing";

export function desktopFromExit(exitCode: number): Desktop {
  if (exitCode === DESKTOP_DRAWN) return "drawn";
  if (exitCode === DESKTOP_UNPAINTED) return "unpainted";
  return "missing";
}

export interface TcpPort {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface Upstream {
  socket: WebSocket;
  first: MessageEvent;
}

const RFB_BANNER = "RFB ";

function startsWithBanner(data: unknown): boolean {
  if (typeof data === "string") return data.startsWith(RFB_BANNER);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data, 0, Math.min(4, data.byteLength))) === RFB_BANNER;
  return false;
}

export async function openUpstream(port: TcpPort, patienceMs: number): Promise<Upstream | null> {
  let response: Response | undefined;
  try {
    response = await within(port.fetch("http://container/websockify", { headers: { upgrade: "websocket" } }), patienceMs);
  } catch {
    return null;
  }
  const socket = response?.webSocket ?? null;
  if (!socket) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  socket.binaryType = "arraybuffer";
  socket.accept();
  const first = await new Promise<MessageEvent | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), patienceMs);
    const finish = (value: MessageEvent | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.addEventListener("message", (event) => finish(event), { once: true });
    socket.addEventListener("close", () => finish(null), { once: true });
    socket.addEventListener("error", () => finish(null), { once: true });
  });
  if (first && startsWithBanner(first.data)) return { socket, first };
  try {
    socket.close(1000, "not ready");
  } catch {}
  return null;
}

export async function answersRfb(port: TcpPort): Promise<boolean> {
  const upstream = await openUpstream(port, RFB_PROBE_MS);
  if (!upstream) return false;
  try {
    upstream.socket.close(1000, "probe");
  } catch {}
  return true;
}

export interface HoldOptions {
  holdMs: number;
  attemptMs: number;
  stillWanted: () => boolean;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function holdUpstream(port: TcpPort, options: HoldOptions): Promise<Upstream | null> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? pause;
  const giveUpAt = now() + options.holdMs;
  for (;;) {
    const upstream = await openUpstream(port, options.attemptMs);
    if (upstream) return upstream;
    if (now() >= giveUpAt || !options.stillWanted()) return null;
    await wait(READY_POLL_MS);
  }
}
