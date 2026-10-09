import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

export function botsWithoutServer(bots: Bot[], server: string): Bot[] {
  return bots.filter((bot) => !bot.hidden && Array.isArray(bot.mcpServers) && !bot.mcpServers.includes(server));
}

export function AddServerToBots({ server, className }: { server: string; className?: string }) {
  const { state, dispatch } = useStore();
  const missing = botsWithoutServer(state.bots ?? [], server);
  if (!missing.length) return null;
  return (
    <div data-add-server={server} className={className}>
      <span>{t("mcpConnectors.ownLists", { count: missing.length })}</span>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {missing.map((bot) => (
          <button
            key={bot.id}
            type="button"
            data-add-server-bot={bot.id}
            onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { mcpServers: [...(bot.mcpServers ?? []), server] } })}
            className="rounded-full bg-control px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
          >
            {t("mcpConnectors.addTo", { name: bot.name })}
          </button>
        ))}
      </div>
    </div>
  );
}
