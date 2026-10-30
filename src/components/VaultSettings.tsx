import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { KeyRound, Loader2, Pencil, Plus, Upload } from "lucide-react";

import { VAULT_IMPORT_BYTES, VAULT_MAX_LOGINS, VAULT_NOTE_CHARS, VAULT_VALUE_CHARS, type VaultImportResult, type VaultLogin, type VaultView } from "../../shared/vault";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { api, ApiError } from "@/state/store";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";

const inputCls = "h-9 w-full rounded-lg border-[0.5px] border-ink/15 bg-composer px-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent motion-reduce:transition-none";
const quietButtonCls = "rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 motion-reduce:transition-none";

export function vaultMatches(login: VaultLogin, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${login.site} ${login.username} ${login.note ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

const problem = (failure: unknown, fallback: string) => failure instanceof ApiError && failure.status === 400 ? failure.message : fallback;

export function VaultSettings() {
  const [view, setView] = useState<VaultView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<VaultView>("/api/vault", { timeoutMs: 15_000 }).then((next) => {
      if (!active) return;
      setView(next);
      setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);

  const logins = useMemo(() => (view?.logins ?? []).filter((login) => vaultMatches(login, query)), [view, query]);

  if (!view) {
    return (
      <SettingsGroup label={t("vault.title")} testId="vault">
        <SettingsRows>
          <div className="flex items-center gap-2 py-4 text-[13px] text-ink-secondary">
            {failed ? (
              <>
                {t("vault.loadFailed")}
                <button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }} className="underline transition-opacity hover:opacity-80">{t("vault.retry")}</button>
              </>
            ) : <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          </div>
        </SettingsRows>
      </SettingsGroup>
    );
  }

  if (!view.available) {
    return (
      <SettingsGroup label={t("vault.title")} testId="vault">
        <SettingsRows>
          <p className="py-4 text-[13px] leading-relaxed text-ink-secondary">{t(view.reason === "unreadable" ? "vault.unreadable" : "vault.cloudOnly")}</p>
        </SettingsRows>
      </SettingsGroup>
    );
  }

  const saved = (login: VaultLogin) => {
    setView((current) => current && { ...current, logins: [...current.logins.filter((entry) => entry.id !== login.id), login].sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)) });
    setEditing(null);
  };

  const remove = async (login: VaultLogin) => {
    if (removing || !window.confirm(t("vault.removeConfirm", { site: login.site }))) return;
    setRemoving(login.id);
    setNote(null);
    try {
      await api(`/api/vault/logins/${encodeURIComponent(login.id)}`, { method: "DELETE" });
      setView((current) => current && { ...current, logins: current.logins.filter((entry) => entry.id !== login.id) });
    } catch {
      setNote(t("vault.removeFailed"));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <SettingsGroup
        label={t("vault.title")}
        testId="vault"
        action={editing === "new" ? null : (
          <button type="button" onClick={() => setEditing("new")} className="flex items-center gap-1 text-[12px] text-ink-secondary transition-colors hover:text-ink">
            <Plus size={13} aria-hidden="true" />{t("vault.add")}
          </button>
        )}
      >
        <p className="px-4 pb-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("vault.intro")} {t("vault.where")}</p>
        <SettingsRows data-vault-logins="">
          {view.logins.length > 6 && (
            <div className="border-b border-hairline/40 py-3">
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("vault.search")} aria-label={t("vault.search")} className={inputCls} />
            </div>
          )}
          {editing === "new" && <LoginForm onSaved={saved} onCancel={() => setEditing(null)} />}
          {view.logins.length === 0 && editing !== "new" && <p className="py-4 text-[13px] text-ink-secondary">{t("vault.empty")}</p>}
          {view.logins.length > 0 && logins.length === 0 && <p className="py-4 text-[13px] text-ink-secondary">{t("vault.noMatch")}</p>}
          {logins.map((login) => editing === login.id ? (
            <LoginForm key={login.id} login={login} onSaved={saved} onCancel={() => setEditing(null)} />
          ) : (
            <div key={login.id} data-vault-login={login.site} className="flex items-center gap-3 border-t border-hairline/40 py-3 first:border-t-0">
              <KeyRound size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-ink">{login.site}</div>
                <div className="truncate text-[12px] text-ink-secondary">
                  {[login.username || t("vault.noUsername"), login.note, login.usedAt ? t("vault.lastUsed", { when: relativeTime(login.usedAt) }) : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button type="button" onClick={() => setEditing(login.id)} aria-label={t("vault.edit", { site: login.site })} className="ui-icon-button shrink-0">
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button type="button" disabled={removing !== null} onClick={() => void remove(login)} aria-label={t("vault.removeAria", { site: login.site })} className={cn(quietButtonCls, "text-danger hover:text-danger")}>
                {removing === login.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("vault.remove")}
              </button>
            </div>
          ))}
        </SettingsRows>
        {note && <p role="alert" className="px-4 text-[12px] text-danger">{note}</p>}
      </SettingsGroup>
      <VaultImport onImported={() => setAttempt((value) => value + 1)} />
    </>
  );
}

function LoginForm({ login, onSaved, onCancel }: { login?: VaultLogin; onSaved: (login: VaultLogin) => void; onCancel: () => void }) {
  const [site, setSite] = useState(login?.site ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState(login?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(site.trim()) && (Boolean(login) || password.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const body = JSON.stringify({ site, username, note, ...(password ? { password } : {}) });
    try {
      const result = login
        ? await api<{ login: VaultLogin }>(`/api/vault/logins/${encodeURIComponent(login.id)}`, { method: "PATCH", body })
        : await api<{ login: VaultLogin }>("/api/vault/logins", { method: "POST", body });
      setPassword("");
      onSaved(result.login);
    } catch (failure) {
      setBusy(false);
      setError(problem(failure, t("vault.saveFailed")));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off" data-vault-form="" className="flex flex-col gap-2.5 border-t border-hairline/40 py-3 first:border-t-0">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <input value={site} onChange={(event) => setSite(event.target.value)} placeholder="example.com" aria-label={t("vault.site")} autoFocus={!login} maxLength={300} spellCheck={false} autoCapitalize="off" className={inputCls} />
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("vault.username")} aria-label={t("vault.username")} maxLength={VAULT_VALUE_CHARS} spellCheck={false} autoCapitalize="off" className={inputCls} />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={login ? t("vault.passwordKeep") : t("vault.password")} aria-label={t("vault.password")} autoComplete="new-password" maxLength={VAULT_VALUE_CHARS} className={inputCls} />
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("vault.note")} aria-label={t("vault.note")} maxLength={VAULT_NOTE_CHARS} className={inputCls} />
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={quietButtonCls}>{t("vault.cancel")}</button>
        <button type="submit" disabled={!ready || busy} aria-busy={busy || undefined} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40 motion-reduce:transition-none">
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t("vault.save")}
        </button>
      </div>
    </form>
  );
}

function VaultImport({ onImported }: { onImported: () => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error: boolean; words: string } | null>(null);

  const read = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy) return;
    setResult(null);
    if (file.size > VAULT_IMPORT_BYTES) {
      setResult({ error: true, words: t("vault.importFailed") });
      return;
    }
    setBusy(true);
    try {
      const counts = await api<VaultImportResult>("/api/vault/import", { method: "POST", body: JSON.stringify({ csv: await file.text() }), timeoutMs: 60_000 });
      const words = [t("vault.imported", { added: counts.added, updated: counts.updated, skipped: counts.skipped })];
      if (counts.full) words.push(t("vault.importFull", { count: counts.full, max: VAULT_MAX_LOGINS }));
      setResult({ error: false, words: words.join(" ") });
      onImported();
    } catch (failure) {
      setResult({ error: true, words: problem(failure, t("vault.importFailed")) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup label={t("vault.import")} testId="vault-import">
      <SettingsRows>
        <div className="flex flex-col gap-2 py-4">
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("vault.importHint")}</p>
          <div>
            <button type="button" disabled={busy} onClick={() => picker.current?.click()} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink transition-colors hover:bg-control/80 disabled:opacity-50 motion-reduce:transition-none">
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Upload size={13} aria-hidden="true" />}
              {busy ? t("vault.importing") : t("vault.import")}
            </button>
            <input ref={picker} type="file" accept=".csv,text/csv" hidden onChange={(event) => void read(event)} data-vault-import="" />
          </div>
          {result && <p role={result.error ? "alert" : "status"} className={cn("text-[12px]", result.error ? "text-danger" : "text-success")}>{result.words}</p>}
        </div>
      </SettingsRows>
    </SettingsGroup>
  );
}
