import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

const MAX_RULES = 20;
const MAX_CHARS = 1_000;

type Kind = "allow" | "block";
type Rules = Record<Kind, string[]>;

const tidy = (rules: Rules): Rules => ({
  allow: rules.allow.map((rule) => rule.trim()).filter(Boolean),
  block: rules.block.map((rule) => rule.trim()).filter(Boolean),
});

const sameRules = (a: Rules, b: Rules) => JSON.stringify(a) === JSON.stringify(b);

function RuleList({ kind, rules, onChange, onCommit }: {
  kind: Kind;
  rules: string[];
  onChange: (next: string[]) => void;
  onCommit: (next: string[]) => void;
}) {
  const title = t(kind === "allow" ? "settings.autoReview.allow" : "settings.autoReview.block");
  const placeholder = t(kind === "allow" ? "settings.autoReview.allowPlaceholder" : "settings.autoReview.blockPlaceholder");
  return (
    <div className="flex flex-col gap-2" data-auto-review-list={kind}>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {rules.map((rule, index) => (
        <div key={index} className="flex items-start gap-2">
          <textarea
            aria-label={`${title} ${index + 1}`}
            value={rule}
            rows={2}
            maxLength={MAX_CHARS}
            placeholder={placeholder}
            onChange={(event) => onChange(rules.map((current, at) => (at === index ? event.target.value : current)))}
            onBlur={() => onCommit(rules)}
            className="min-h-[44px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
          <button
            type="button"
            aria-label={t("settings.autoReview.remove")}
            onClick={() => onCommit(rules.filter((_, at) => at !== index))}
            className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      {rules.length < MAX_RULES && (
        <button
          type="button"
          onClick={() => onChange([...rules, ""])}
          className="flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
        >
          <Plus size={14} aria-hidden="true" />
          {t("settings.autoReview.add")}
        </button>
      )}
    </div>
  );
}

export function AutoReviewSettings() {
  const { state, dispatch } = useStore();
  const saved = state.config?.clef?.autoReview ?? { allow: [], block: [] };
  const ready = state.config?.clef?.ready === true;
  const [draft, setDraft] = useState<Rules>({ allow: saved.allow, block: saved.block });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const confirmed = useRef<Rules>(tidy({ allow: saved.allow, block: saved.block }));

  useEffect(() => {
    const incoming = tidy({ allow: saved.allow, block: saved.block });
    if (sameRules(incoming, confirmed.current)) return;
    confirmed.current = incoming;
    setDraft({ allow: incoming.allow, block: incoming.block });
  }, [saved.allow, saved.block]);

  const commit = async (next: Rules) => {
    setDraft(next);
    const cleaned = tidy(next);
    if (sameRules(cleaned, confirmed.current)) return;
    setStatus("saving");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ decider: { autoReview: cleaned } }),
        timeoutMs: 10_000,
      });
      confirmed.current = cleaned;
      dispatch({ type: "configStatus", config });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4" data-auto-review="">
      <p className="text-[13px] leading-relaxed text-ink-secondary">{t("settings.autoReview.explain")}</p>
      {!ready && <p className="text-[12px] text-ink-secondary">{t("settings.autoReview.unavailable")}</p>}
      <RuleList kind="allow" rules={draft.allow} onChange={(allow) => setDraft({ ...draft, allow })} onCommit={(allow) => void commit({ ...draft, allow })} />
      <RuleList kind="block" rules={draft.block} onChange={(block) => setDraft({ ...draft, block })} onCommit={(block) => void commit({ ...draft, block })} />
      <div className="min-h-4 text-[12px]" role="status">
        {status === "saving" && <span className="text-ink-secondary">{t("settings.profile.saving")}</span>}
        {status === "saved" && <span className="text-success">{t("settings.profile.saved")}</span>}
        {status === "error" && <span className="text-danger">{t("settings.autoReview.saveError")}</span>}
      </div>
    </div>
  );
}
