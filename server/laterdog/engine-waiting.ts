import type { EngineLink } from "./engine-remote.ts";

export const ENGINE_WAIT_NOTICE_MS = 2_000;
export const ENGINE_COMPUTER_RESOURCE = "engine-computer";

export type EngineWait = { waiting: true } | { waiting: false; opened: boolean; waitedMs: number };

export function watchEngineOpening(link: EngineLink, onWait: (wait: EngineWait) => void, noticeAfterMs = ENGINE_WAIT_NOTICE_MS, now: () => number = Date.now): void {
  if (!link.opening) return;
  const since = now();
  let announced = false;
  let settled = false;
  const notice = setTimeout(() => {
    if (settled) return;
    announced = true;
    onWait({ waiting: true });
  }, noticeAfterMs);
  notice.unref?.();
  const settle = (opened: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(notice);
    link.off("open", onOpen);
    link.off("close", onClose);
    if (announced) onWait({ waiting: false, opened, waitedMs: Math.max(0, now() - since) });
  };
  const onOpen = () => settle(true);
  const onClose = () => settle(false);
  link.once("open", onOpen);
  link.once("close", onClose);
}

export type EngineWaitEvent =
  | { type: "turn.wait_started"; resource: string }
  | { type: "turn.wait_ended"; resource: string; waitedMs: number; outcome: "acquired" | "gave_up" };

export function engineWaitEvent(wait: EngineWait): EngineWaitEvent {
  return wait.waiting
    ? { type: "turn.wait_started", resource: ENGINE_COMPUTER_RESOURCE }
    : { type: "turn.wait_ended", resource: ENGINE_COMPUTER_RESOURCE, waitedMs: wait.waitedMs, outcome: wait.opened ? "acquired" : "gave_up" };
}
