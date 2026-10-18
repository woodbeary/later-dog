import type { ComponentType } from "react";
import { AgentChat } from "./AgentChat";
import { Automations } from "./Automations";
import { Channels } from "./Channels";
import { Hands } from "./Hands";
import { Terminal } from "./Terminal";
import type { SceneProps } from "./types";

export type { SceneProps };

const SCENES: Record<string, ComponentType<SceneProps>> = {
  agents: AgentChat,
  automations: Automations,
  channels: Channels,
  hands: Hands,
  terminal: Terminal,
};

export const REEL = ["agents", "hands", "channels", "automations"] as const;

export function sceneFor(id: string): ComponentType<SceneProps> | null {
  return SCENES[id] ?? null;
}
