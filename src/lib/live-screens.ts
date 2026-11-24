import type { ServerFrame } from "../../shared/wire";

export type LiveScreen = { botId: string; png: string; mime: string; at: number };
export type LiveScreenAction = { type: "liveScreen"; threadId: string; screen: LiveScreen | null };

export function liveScreenAction(frame: ServerFrame, now = Date.now()): LiveScreenAction | null {
  if (frame.kind === "screen.end") return { type: "liveScreen", threadId: frame.threadId, screen: null };
  if (frame.kind !== "screen" || frame.place !== "mac" || !frame.png) return null;
  return { type: "liveScreen", threadId: frame.threadId, screen: { botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/jpeg", at: now } };
}

export function withLiveScreen(screens: Record<string, LiveScreen>, action: LiveScreenAction): Record<string, LiveScreen> {
  if (action.screen) return { ...screens, [action.threadId]: action.screen };
  if (!(action.threadId in screens)) return screens;
  const { [action.threadId]: _ended, ...rest } = screens;
  return rest;
}
