import type { WireBot } from "../../shared/wire.ts";

export function newDogComputer(cloudHome: boolean): WireBot["computer"] {
  return cloudHome ? "cloud" : undefined;
}
