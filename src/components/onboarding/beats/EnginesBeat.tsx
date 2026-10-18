import { useCallback, useEffect, useRef, useState } from "react";
import { AccountRow, type Report } from "@/components/EngineAccountRow";
import { engineReady } from "@/components/EngineLibrary";
import { t } from "@/lib/i18n";
import { ONBOARDING_ACCOUNT_IDS, onboardingAccounts, type OnboardingAccountId } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { FreeAiRow } from "./FreeAiRow";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";
import type { TrialStatus } from "@/components/CloudTrial";

export function EnginesBeat({ onNext, setMascot, bump }: BeatProps & { hosted?: boolean; onOpenOrganisation?: () => void }) {
  const { state, dispatch } = useStore();
  const [loaded, setLoaded] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [message, setMessage] = useState<{ id: OnboardingAccountId; text: string } | null>(null);
  const [freeReady, setFreeReady] = useState(false);
  const [freeStatus, setFreeStatus] = useState<TrialStatus | null>(null);
  const markFreeReady = useCallback(() => setFreeReady(true), []);

  useEffect(() => {
    let active = true;
    let retry: number | undefined;
    const load = async () => {
      try {
        const { instances } = await api<{ instances?: InstanceInfo[] }>("/api/instances", { timeoutMs: 10_000 });
        if (!active) return;
        dispatch({ type: "instances", instances: instances ?? [] });
        setLoaded(true);
        setCheckFailed(false);
      } catch {
        if (!active) return;
        setCheckFailed(true);
        retry = window.setTimeout(() => void load(), 3_000);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(retry);
    };
  }, [dispatch]);

  const report = useCallback<Report>((id, text) => {
    setMessage((current) => (text ? { id, text } : current?.id === id ? null : current));
  }, []);

  const instances = loaded || state.instances.length ? state.instances : null;
  const accounts = instances ? onboardingAccounts(instances, engineReady) : null;
  const loading = accounts === null;
  const ownReady = accounts?.some((account) => account.status === "ready") ?? false;
  const anyReady = ownReady || freeReady;
  const freeFirstAtLoad = useRef<boolean | null>(null);
  if (freeFirstAtLoad.current === null && !loading) freeFirstAtLoad.current = !ownReady;
  const freeFirst = freeFirstAtLoad.current === true;

  useEffect(() => {
    if (loading) {
      setMascot("searching");
    } else if (anyReady) {
      setMascot("proud");
      bump("success");
    } else {
      setMascot("curious");
    }
  }, [loading, anyReady, setMascot, bump]);

  const rowMessage = message && accounts?.find((account) => account.id === message.id)?.status !== "ready" ? message.text : "";
  const notice = loading && checkFailed ? t("onboarding.engines.checkFailed") : rowMessage;

  return (
    <div className="stagger flex min-h-0 flex-col">
      <p className="animate-rise mt-1 text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {freeStatus ? t("onboarding.engines.subtitleFree") : t("onboarding.engines.subtitle")}
      </p>
      <ul
        aria-busy={loading}
        className="animate-rise mt-4 min-h-0 divide-y divide-hairline/40 overflow-y-auto rounded-xl bg-card [scrollbar-width:thin]"
        style={staggerIndex(1)}
      >
        {freeFirst && <FreeAiRow primary onReady={markFreeReady} onStatus={setFreeStatus} />}
        {ONBOARDING_ACCOUNT_IDS.map((id) => (
          <AccountRow key={id} id={id} account={accounts?.find((account) => account.id === id) ?? null} report={report} />
        ))}
        {!freeFirst && !loading && <FreeAiRow onReady={markFreeReady} onStatus={setFreeStatus} />}
      </ul>
      <p aria-live="polite" className="mt-2 min-h-5 text-[13px] leading-5 text-danger">
        {notice}
      </p>
      <PrimaryButton onClick={onNext} className="animate-rise mt-3" style={staggerIndex(2)}>
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
