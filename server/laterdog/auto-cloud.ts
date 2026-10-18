export interface AutoCloudTurn {
  wants: "cloud" | "vm" | "local" | "off" | undefined;
  alreadyMounted: boolean;
  backend: "box" | "vps";
  configured: boolean;
  placeRefused: boolean;
  engineSupportsComputer: boolean;
  computerToolsAllowed: boolean;
}

export function mountsAutoCloud(turn: AutoCloudTurn): boolean {
  return turn.wants === undefined && !turn.alreadyMounted && turn.backend === "box" &&
    turn.configured && !turn.placeRefused && turn.engineSupportsComputer && turn.computerToolsAllowed;
}
