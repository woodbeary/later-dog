import type { ProviderAdapter } from "./contracts.ts";
import { supportsWorkspaceFiles } from "./workspace.ts";

type Engine = { driverKind: string; capabilities: ProviderAdapter["capabilities"] };

export function recoveryCapabilityError(from: Engine, to: Engine): string | undefined {
  if (from.driverKind === "antigravityAgent" || to.driverKind === "antigravityAgent") {
    return "Antigravity keeps its own Google sign-in, so later.dog never moves work onto or off it on its own.";
  }
  if (supportsWorkspaceFiles(from.driverKind) !== supportsWorkspaceFiles(to.driverKind)) {
    return "The backup cannot use the same workspace.";
  }
  const tools = ["agentsMcp", "computerMcp", "composioMcp",
    "browserMcp", "localComputerMcp", "customMcp", "images"] as const;
  if (tools.some(key => from.capabilities[key] === true && to.capabilities[key] !== true)) {
    return "The backup does not support all of this engine's tools and attachments.";
  }
}
