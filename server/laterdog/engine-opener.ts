import { engineComputer, ENGINE_BOOT_BUDGET_MS } from "../computers.ts";
import { ENGINE_PREPARE_BUDGET_MS, ENGINE_STEP_BUDGET_MS, engineScripts, prepareEngineComputer, processStreamLink, relayCommand } from "./engine-computer.ts";
import type { EngineOpener } from "./engine-placement.ts";

export const ENGINE_OPEN_BUDGET_MS = ENGINE_BOOT_BUDGET_MS + ENGINE_PREPARE_BUDGET_MS + ENGINE_STEP_BUDGET_MS;

export function computerEngineOpener(): EngineOpener {
  return {
    get proxyPath() { return engineScripts().proxy; },
    get guestProvider() {
      const relay = engineScripts(true);
      return { entry: relay.dir + "/provider-guest.mjs", proxy: relay.proxy };
    },
    openBudgetMs: ENGINE_OPEN_BUDGET_MS,
    async open(botId, plan, signal) {
      const relay = engineScripts(Boolean(plan.guestRuntime));
      const { box, stream } = await engineComputer(botId, signal);
      await prepareEngineComputer(box, plan, relay);
      return processStreamLink(await stream(), relayCommand(relay));
    },
  };
}
