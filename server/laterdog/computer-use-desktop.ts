import { xdotoolCommand } from "./computer-use-actions.ts";
import { sameSize, type Size } from "./computer-use-frame.ts";
import type { DesktopAction, UseDesktop } from "./computer-use-loop.ts";

export interface ComputerCalls {
  exec(id: string, command: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  read(id: string, path: string, maxBytes: number): Promise<Buffer>;
}

export const FRAME_DIR = "/tmp/laterdog-computer-use";
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 30_000;

export function captureCommand(frame: Size, screen: Size): { command: string; path: string } {
  const scaled = !sameSize(frame, screen);
  return {
    command: [
      `mkdir -p ${FRAME_DIR}`,
      `rm -f ${FRAME_DIR}/frame.jpg ${FRAME_DIR}/frame-thumb.jpg`,
      `scrot --overwrite --pointer --quality 75 ${scaled ? `--thumb ${frame.width}x${frame.height} ` : ""}${FRAME_DIR}/frame.jpg >/dev/null`,
    ].join(" && "),
    path: `${FRAME_DIR}/${scaled ? "frame-thumb.jpg" : "frame.jpg"}`,
  };
}

function settled(result: { exitCode: number | null; stdout: string; stderr: string }, what: string): string {
  if (result.exitCode === 0) return result.stdout;
  const why = result.stderr.replace(/\s+/g, " ").trim().slice(0, 300);
  throw new Error(`${what} failed${why ? `: ${why}` : ` (exit ${result.exitCode ?? "none"})`}.`);
}

export function actionTimeoutMs(action: DesktopAction): number {
  if (action.kind === "hold_key") return ACTION_TIMEOUT_MS + action.seconds * 1000;
  if (action.kind === "type") return ACTION_TIMEOUT_MS + action.text.length * 15;
  return ACTION_TIMEOUT_MS;
}

export class CloudDesktop implements UseDesktop {
  readonly #calls: ComputerCalls;
  readonly #computerId: string;

  constructor(calls: ComputerCalls, computerId: string) {
    this.#calls = calls;
    this.#computerId = computerId;
  }

  async screen(): Promise<Size> {
    const output = settled(await this.#calls.exec(this.#computerId, "xdotool getdisplaygeometry", ACTION_TIMEOUT_MS), "Reading the screen size");
    const match = /^(\d{1,5}) (\d{1,5})\s*$/.exec(output);
    if (!match) throw new Error("The desktop did not report its screen size.");
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  async screenshot(frame: Size, screen: Size): Promise<Buffer> {
    const capture = captureCommand(frame, screen);
    settled(await this.#calls.exec(this.#computerId, capture.command, ACTION_TIMEOUT_MS), "The screenshot");
    const shot = await this.#calls.read(this.#computerId, capture.path, MAX_FRAME_BYTES);
    if (!shot.length) throw new Error("The screenshot came back empty.");
    return shot;
  }

  async act(action: DesktopAction): Promise<string> {
    return settled(await this.#calls.exec(this.#computerId, xdotoolCommand(action), actionTimeoutMs(action)), `The ${action.kind.replace("_", " ")} action`);
  }
}
