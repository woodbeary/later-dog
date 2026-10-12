// Shown instead of a chat when nothing on this machine can run a bot.
//
// The alternative — which is what used to happen — is a chat that looks
// completely functional until the first message, then fails with a raw spawn
// error. Every engine unavailable is a setup state, not an error state, so it
// gets a screen that says what to do rather than a bot that can't answer.
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useStore } from "@/state/store";
import { EngineGroupLabel } from "@/components/EngineGroupLabel";
import { engineReady } from "@/components/EngineLibrary";
import { EngineSetup, installCommandFor } from "@/components/EngineSetup";
import { AccountRow, type Report } from "@/components/onboarding/beats/EnginesBeat";
import { FreeAiRow } from "@/components/onboarding/beats/FreeAiRow";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { splitEngineRail } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { ONBOARDING_ACCOUNT_IDS, onboardingAccounts, type OnboardingAccountId } from "@/lib/onboarding";

export function NoEngines() {
  const { state, refreshInstances } = useStore();
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const [rechecking, setRechecking] = useState(false);
  const [more, setMore] = useState(false);
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

  // Only things you actually install belong on a "get started" screen. The
  // Boat cloud runner also reports unavailable here, but it's configured with
  // a token in settings rather than installed, so listing it would just be a
  // dead end alongside the real options.
  const engines = state.instances
    .filter((i) => i.install)
    // An engine with a command for this platform is one the user can act on
    // right now; the rest (GUI downloads, POSIX-only installers on Windows)
    // sort below so the actionable path is the obvious one.
    .sort((a, b) => {
      const aCmd = installCommandFor(a.install) ? 0 : 1;
      const bCmd = installCommandFor(b.install) ? 0 : 1;
      return aCmd - bCmd;
    });

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
          aria-expanded={more}
          onClick={() => setMore((open) => !open)}
          className="mt-4 flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink"
        >
          <ChevronDown size={14} className={more ? "rotate-180 transition-transform" : "transition-transform"} />
          {t("noEngines.more")}
        </button>
        {more && <div className="mt-3 flex flex-col gap-2.5">
          {(() => {
            const { subscription, custom } = splitEngineRail(engines);
            const card = (instance: (typeof engines)[number]) => (
              <div key={instance.instanceId} className="rounded-xl border border-hairline/40 bg-card p-3.5">
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  <InstanceProviderMark instance={instance} size={16} />
                  {instance.displayName}
                </div>
                <EngineSetup
                  instance={instance}
                  intent={instance.access === "custom" ? "inject" : "cloud"}
                  className="mt-0.5"
                />
              </div>
            );
            return (
              <>
                {subscription.length > 0 && <EngineGroupLabel className="px-1">{t("engines.cloud")}</EngineGroupLabel>}
                {subscription.map(card)}
                {custom.length > 0 && <EngineGroupLabel className="px-1 pt-1">{t("engines.local")}</EngineGroupLabel>}
                {custom.map(card)}
              </>
            );
          })()}
        </div>}

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
