import type { TurnResults } from "../../shared/turn-results";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";

const CHANGE_WORDS = {
  created: "chat.results.created",
  edited: "chat.results.edited",
  deleted: "chat.results.deleted",
} as const;

export function hasTurnResults(results: TurnResults | undefined): results is TurnResults {
  return Boolean(results?.files?.length || results?.links?.length || results?.commands);
}

export function TurnResultsBlock({ results }: { results: TurnResults | undefined }) {
  if (!hasTurnResults(results)) return null;
  const files = results.files ?? [];
  const changed = files.length + (results.moreFiles ?? 0);
  return (
    <div data-turn-results="" className="mt-1 max-w-[560px] space-y-1 pl-1 text-[11px] text-ink-tertiary">
      {files.length > 0 && (
        <div data-turn-results-files="">
          <div>{changed === 1 ? t("chat.results.filesOne") : t("chat.results.files", { count: changed })}</div>
          <ul className="mt-0.5 space-y-0.5">
            {files.map((file) => (
              <li key={file.path} className="flex min-w-0 gap-2">
                <span className="min-w-0 truncate font-mono text-ink-secondary" title={file.path}>{file.path}</span>
                <span className="shrink-0">{t(CHANGE_WORDS[file.change])}</span>
              </li>
            ))}
            {results.moreFiles ? <li>{t("approval.outbound.more", { count: results.moreFiles })}</li> : null}
          </ul>
        </div>
      )}
      {results.links?.map((link) => (
        <div key={link.url} className="min-w-0 truncate">
          {link.kind === "pull-request" && <span>{t("chat.results.pullRequest")} </span>}
          <a href={link.url} target="_blank" rel="noopener noreferrer" data-turn-results-link="" className="text-accent-text hover:underline"
            onClick={(event) => { if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(link.url); } }}>
            {link.label}
          </a>
        </div>
      ))}
      {results.commands ? (
        <div data-turn-results-commands="">{results.commands === 1 ? t("chat.results.commandsOne") : t("chat.results.commands", { count: results.commands })}</div>
      ) : null}
    </div>
  );
}
