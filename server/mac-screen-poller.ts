export const MAC_SCREEN_POLL_MS = 1500;
export const MAC_FRAME_MAX_CHARS = Math.ceil((1024 * 1024 * 4) / 3);

export type MacFrame = { png: string; mime: "image/jpeg" | "image/png" };

const MIMES: Record<string, MacFrame["mime"]> = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png" };

export function macFrameFrom(result: unknown): MacFrame | null {
  if (!result || typeof result !== "object") return null;
  const { png, format } = result as { png?: unknown; format?: unknown };
  if (typeof png !== "string" || !png || png.length > MAC_FRAME_MAX_CHARS) return null;
  const mime = typeof format === "string" ? MIMES[format] : undefined;
  return mime ? { png, mime } : null;
}

export function createMacScreenPoller(input: {
  capture: () => Promise<unknown>;
  active: () => boolean;
  onFrame: (frame: MacFrame) => void;
  onStop: () => void;
  pollMs?: number;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    input.onStop();
  };
  const tick = async () => {
    if (!timer || inFlight) return;
    if (!input.active()) { stop(); return; }
    inFlight = true;
    try {
      const frame = macFrameFrom(await input.capture());
      if (frame && timer) input.onFrame(frame);
    } catch {} finally {
      inFlight = false;
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), input.pollMs ?? MAC_SCREEN_POLL_MS);
      void tick();
    },
    stop,
    running: () => timer !== null,
  };
}
