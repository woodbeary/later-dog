import { api, type Action, type Bot, type ConfigStatus } from "@/state/store";
import { builtInBrowserEnabled } from "@/lib/feature-flags";

export async function turnOnBrowser(
  config: ConfigStatus | null | undefined,
  bot: Pick<Bot, "id" | "browser">,
  dispatch: (action: Action) => void,
): Promise<void> {
  if (!builtInBrowserEnabled(config)) {
    const next: ConfigStatus = await api("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
    dispatch({ type: "configStatus", config: next });
  }
  if (bot.browser === false) dispatch({ type: "updateBot", botId: bot.id, patch: { browser: true } });
}
