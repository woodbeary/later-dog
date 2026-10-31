import { useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { ASK_FIRST_MAX_RULES, ASK_FIRST_RULE_CHARS, askFirstRules } from "../../shared/ask-first";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export function AskFirstGroup() {
  const { state, dispatch } = useStore();
  const rules = askFirstRules(state.config?.profile?.askFirst);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async (next: string[]) => {
    setSaving(true);
    setFailed(false);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { askFirst: next } }), timeoutMs: 10_000 });
      dispatch({ type: "profileSaved", profile: { askFirst: askFirstRules(config.profile?.askFirst ?? next) } });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const next = askFirstRules([...rules, draft]);
    if (saving || next.length === rules.length) return;
    if (await save(next)) setDraft("");
  };

  const full = rules.length >= ASK_FIRST_MAX_RULES;
  return (
    <SettingsGroup label={t("askFirst.title")} testId="ask-first">
      <p className="px-4 pb-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("askFirst.hint")}</p>
      <SettingsRows data-ask-first="">
        {rules.map((rule) => (
          <div key={rule} data-ask-first-rule="" className="flex items-center gap-3 border-t border-hairline/40 py-2.5 first:border-t-0">
            <span className="min-w-0 flex-1 break-words text-[13.5px] text-ink">{rule}</span>
            <button type="button" disabled={saving} onClick={() => void save(rules.filter((entry) => entry !== rule))} aria-label={t("askFirst.remove", { rule })} className="ui-icon-button shrink-0">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <form onSubmit={(event) => void add(event)} className="flex items-center gap-2 border-t border-hairline/40 py-2.5 first:border-t-0">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={ASK_FIRST_RULE_CHARS}
            disabled={full}
            placeholder={t(full ? "askFirst.full" : "askFirst.placeholder")}
            aria-label={t("askFirst.add")}
            className="h-9 min-w-0 flex-1 rounded-lg border-[0.5px] border-ink/15 bg-composer px-3 text-[13.5px] text-ink outline-none transition-colors focus:border-accent disabled:opacity-60 motion-reduce:transition-none"
          />
          <button type="submit" disabled={saving || full || !draft.trim()} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40 motion-reduce:transition-none">
            {saving && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {t("askFirst.add")}
          </button>
        </form>
      </SettingsRows>
      {failed && <p role="alert" className="px-4 text-[12px] text-danger">{t("askFirst.saveFailed")}</p>}
    </SettingsGroup>
  );
}
