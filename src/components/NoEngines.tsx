import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useStore } from "@/state/store";
import { engineReady } from "@/components/EngineLibrary";
import { AccountRow, type Report } from "@/components/onboarding/beats/EnginesBeat";
import { FreeAiRow } from "@/components/onboarding/beats/FreeAiRow";
import { t } from "@/lib/i18n";
import { ONBOARDING_ACCOUNT_IDS, onboardingAccounts, type OnboardingAccountId } from "@/lib/onboarding";

export function NoEngines() {
  const { state, dispatch, refreshInstances } = useStore();
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const [rechecking, setRechecking] = useState(false);
  const [message, setMessage] = useState<{ id: OnboardingAccountId; text: string } | null>(null);
  const report = useCallback<Report>((id, text) => {
    setMessage((current) => (text ? { id, text } : current?.id === id ? null : current));
  }, []);
  const accounts = onboardingAccounts(state.instances, engineReady);
  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  if (remoteClient) {
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <div className="max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">The host needs an agent engine</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            Configure Claude, ACP, or another supported engine in later.dog on the host computer, then return here.
          </p>
          <button onClick={() => void recheck()} disabled={rechecking} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60">
            {rechecking ? "Checking…" : "Check again"}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">
          {t("noEngines.intro")}
        </p>

        <ul className="mt-6 divide-y divide-hairline/40 overflow-hidden rounded-xl bg-card">
          <FreeAiRow primary onReady={() => void refreshInstances()} />
          {ONBOARDING_ACCOUNT_IDS.map((id) => (
            <AccountRow key={id} id={id} account={accounts.find((account) => account.id === id) ?? null} report={report} />
          ))}
        </ul>
        <p aria-live="polite" className="mt-2 min-h-5 text-[13px] leading-5 text-danger">{message?.text ?? ""}</p>

        <button
          type="button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "general" })}
          className="mt-4 rounded-full bg-control px-3.5 py-1.5 text-[13px] text-ink hover:bg-control-hover"
        >
          {t("noEngines.more")}
        </button>

        <button
          onClick={recheck}
          disabled={rechecking}
          className="mt-6 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
        >
          {rechecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {rechecking ? t("common.checking") : t("common.checkAgain")}
        </button>
      </div>
    </main>
  );
}
