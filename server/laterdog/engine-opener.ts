import { engineComputer } from "../computers.ts";
import { engineScripts, installEngineRelay, prepareEngineComputer, processStreamLink, relayCommand } from "./engine-computer.ts";
import type { EngineOpener } from "./engine-placement.ts";

export function computerEngineOpener(): EngineOpener {
  return {
    get proxyPath() { return engineScripts().proxy; },
    async open(botId, plan) {
      const relay = engineScripts();
      const { box, stream } = await engineComputer(botId);
      await prepareEngineComputer(box, plan, relay);
      return processStreamLink(await stream(), relayCommand(relay));
    },
    async relay(botId) {
      const relay = engineScripts();
      const { box, stream } = await engineComputer(botId);
      await installEngineRelay(box, relay);
      return processStreamLink(await stream(), relayCommand(relay));
    },
  };
}
