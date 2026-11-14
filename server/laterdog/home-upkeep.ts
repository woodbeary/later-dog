import { endLeftovers } from "./turn-leftovers.ts";
import { turnUpkeep } from "./turn-upkeep.ts";

export interface HomeUpkeepDeps {
  subscribe(listener: (event: { type: string; threadId: string }) => void): void;
  atWork(threadId: string): boolean;
  log?: (line: string) => void;
}

export function startHomeUpkeep(deps: HomeUpkeepDeps): void {
  const log = deps.log ?? ((line: string) => console.log(line));
  deps.subscribe(turnUpkeep({ atWork: deps.atWork, endLeftovers: (mark) => endLeftovers({ mark }), log }));
}
