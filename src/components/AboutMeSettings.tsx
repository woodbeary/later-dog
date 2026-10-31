import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, CircleHelp, Copy } from "lucide-react";
import { api, ApiError, useStore, type ConfigStatus } from "@/state/store";
import { Switch } from "./SettingsPrimitives";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { createAboutMeDraft } from "./about-me-draft";

const drafts = new WeakMap<object, ReturnType<typeof createAboutMeDraft>>();

export function AboutMeSettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.profile?.aboutMe ?? "";
  let controller = drafts.get(dispatch);
  if (!controller) {
    controller = createAboutMeDraft(confirmed, async (sent) => {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT", body: JSON.stringify({ profile: { aboutMe: sent } }), timeoutMs: 10_000,
      });
      dispatch({ type: "profileSaved", profile: { aboutMe: config.profile?.aboutMe ?? sent } });
    });
    drafts.set(dispatch, controller);
  }
  const { value, status } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [imports, setImports] = useState(0);
  const { flush } = controller;
  useEffect(() => { controller.confirm(confirmed); }, [controller, confirmed]);
  useEffect(() => () => { void flush(); }, [flush]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor="profile-about-me" className="text-[14px] text-ink">{t("settings.profile.aboutMe")}</label>
        <details className="group relative">
          <summary title={t("settings.profile.aboutMeHelp")} aria-label={t("settings.profile.aboutMeHelp")}
            className="flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 [&::-webkit-details-marker]:hidden">
            <CircleHelp size={14} aria-hidden="true" />
          </summary>
          <p className="absolute left-0 z-30 mt-1 w-56 rounded-xl border border-hairline bg-panel p-3 text-[12px] text-ink-secondary shadow-xl">
            {t("settings.profile.aboutMeHelp")}
          </p>
        </details>
      </div>
      <textarea id="profile-about-me" value={value} rows={5} maxLength={24_000}
        onChange={(event) => controller.edit(event.target.value)}
        onBlur={() => void flush()}
        className="min-h-[120px] w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink focus:outline-none"
      />
      <ImportMemories onImported={(aboutMe) => {
        controller.confirm(aboutMe);
        dispatch({ type: "profileSaved", profile: { aboutMe } });
        setImports((count) => count + 1);
      }} />
      <LearnedFacts key={imports} onChanged={(aboutMe) => { controller.confirm(aboutMe); dispatch({ type: "profileSaved", profile: { aboutMe } }); }} />
      <div className="min-h-4 text-[12px]" role="status">
        {status === "saving" && <span className="text-ink-secondary">{t("settings.profile.saving")}</span>}
        {status === "saved" && <span className="text-success">{t("settings.profile.saved")}</span>}
        {status === "error" && <span className="text-danger">{t("settings.profile.saveError")} {" "}
          <button type="button" onClick={() => void flush()} className="underline transition-opacity hover:opacity-80">{t("settings.profile.retry")}</button>
        </span>}
      </div>
    </div>
  );
}

function ImportMemories({ onImported }: { onImported: (aboutMe: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; words: string } | null>(null);
  const prompt = t("settings.profile.import.prompt");
  const { state: copied, copy } = useCopyFeedback(prompt);

  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{ added: number; full: boolean; aboutMe: string }>("/api/profile/import", {
        method: "POST", body: JSON.stringify({ text }), timeoutMs: 15_000,
      });
      onImported(result.aboutMe);
      setText("");
      setNote({
        error: false,
        words: result.added === 0 ? t("settings.profile.import.nothing")
          : result.full ? t("settings.profile.import.partly", { count: result.added })
            : t("settings.profile.import.added", { count: result.added }),
      });
    } catch (cause) {
      setNote({ error: true, words: cause instanceof Error && cause.message ? cause.message : t("settings.profile.import.error") });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div>
        <button type="button" data-import-memories onClick={() => setOpen(true)}
          className="rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">
          {t("settings.profile.import.open")}
        </button>
        {note && <span role="status" className={note.error ? "text-[12px] text-danger" : "text-[12px] text-ink-secondary"}>{note.words}</span>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-hairline/40 bg-inset p-3" data-import-memories-panel>
      <div className="text-[13px] font-medium text-ink">{t("settings.profile.import.title")}</div>
      <p className="mt-1 text-[12.5px] text-ink-secondary">{t("settings.profile.import.ask")}</p>
      <div className="mt-1.5 flex items-start gap-2 rounded-md bg-card px-2.5 py-2 text-[13px] text-ink">
        <span className="min-w-0 flex-1">{prompt}</span>
        <button type="button" onClick={copy} aria-label={t("settings.profile.import.copy")}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          {copied === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied === "copied" ? t("settings.profile.import.copied") : t("settings.profile.import.copy")}
        </button>
      </div>
      <label htmlFor="import-memories" className="mt-2.5 block text-[12.5px] text-ink-secondary">{t("settings.profile.import.paste")}</label>
      <textarea id="import-memories" value={text} rows={5} maxLength={50_000} onChange={(event) => setText(event.target.value)}
        className="mt-1 min-h-[100px] w-full resize-y rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[13.5px] text-ink focus:outline-none" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()}
          className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
          {t("settings.profile.import.add")}
        </button>
        <button type="button" onClick={() => { setOpen(false); setText(""); }}
          className="rounded-full bg-control px-3.5 py-1.5 text-[13px] text-ink hover:bg-control-hover">
          {t("settings.profile.import.cancel")}
        </button>
        {note && <span role="status" className={note.error ? "text-[12px] text-danger" : "text-[12px] text-ink-secondary"}>{note.words}</span>}
      </div>
    </div>
  );
}

interface LearnedFact {
  id: string;
  text: string;
  botName: string;
  at: number;
}

function LearnedFacts({ onChanged }: { onChanged: (aboutMe: string) => void }) {
  const { state, dispatch } = useStore();
  const reviewing = state.config?.profile?.reviewLearned === true;
  const waiting = state.config?.profile?.learnedWaiting ?? 0;
  const [facts, setFacts] = useState<LearnedFact[]>([]);
  const [pending, setPending] = useState<LearnedFact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ learned: LearnedFact[]; pending?: LearnedFact[] }>("/api/profile/learned")
      .then((result) => { if (!cancelled) { setFacts(result.learned); setPending(result.pending ?? []); } })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [waiting]);

  const act = async (id: string, action: "remove" | "keep" | "dismiss") => {
    setBusy(id);
    setError(null);
    try {
      const result = await api<{ aboutMe?: string; learned: LearnedFact[]; pending?: LearnedFact[] }>(`/api/profile/learned/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      setFacts(result.learned);
      if (result.pending) setPending(result.pending);
      if (typeof result.aboutMe === "string") onChanged(result.aboutMe);
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 413 ? failure.message : t("settings.profile.learned.error"));
    } finally {
      setBusy(null);
    }
  };

  const setReviewing = async (next: boolean) => {
    setError(null);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ profile: { reviewLearned: next } }), timeoutMs: 10_000 });
      dispatch({ type: "profileSaved", profile: { reviewLearned: config.profile?.reviewLearned === true } });
    } catch {
      setError(t("settings.profile.learned.error"));
    }
  };

  const factText = (fact: LearnedFact) => (
    <span className="min-w-0 flex-1">
      {fact.text}{" "}
      <span className="text-[12px] text-ink-secondary">{t("settings.profile.learned.from", { name: fact.botName })}</span>
    </span>
  );
  const button = "rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

  return (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">{t("settings.profile.learned.review")}</div>
          <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.profile.learned.reviewHint")}</p>
        </div>
        <Switch checked={reviewing} onClick={() => void setReviewing(!reviewing)} aria-label={t("settings.profile.learned.review")} />
      </div>
      {pending.length > 0 && (
        <div data-learned-waiting="" className="rounded-lg border border-hairline/40 bg-inset p-3">
          <div className="text-[13px] font-medium text-ink">{t("settings.profile.learned.waiting")}</div>
          <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.profile.learned.waitingHint")}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {pending.map((fact) => (
              <li key={fact.id} className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                {factText(fact)}
                <button type="button" disabled={busy === fact.id} onClick={() => void act(fact.id, "keep")} className={button}>{t("settings.profile.learned.keep")}</button>
                <button type="button" disabled={busy === fact.id} onClick={() => void act(fact.id, "dismiss")} className={button}>{t("settings.profile.learned.dismiss")}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {facts.length > 0 && (
        <div className="rounded-lg border border-hairline/40 bg-inset p-3">
          <div className="text-[13px] font-medium text-ink">{t("settings.profile.learned.title")}</div>
          <p className="mt-0.5 text-[12px] text-ink-secondary">{t("settings.profile.learned.hint")}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {facts.map((fact) => (
              <li key={fact.id} className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                {factText(fact)}
                <button type="button" disabled={busy === fact.id} onClick={() => void act(fact.id, "remove")} className={button}>
                  {t("settings.profile.learned.remove")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
    </div>
  );
}
