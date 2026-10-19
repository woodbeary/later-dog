import { useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { ACCOUNT_ENGINES, AccountMark, pill, type AccountKind } from "@/components/AccountsPanel";
import { engineReady } from "@/components/EngineLibrary";
import { IncludedAiAccount, includedAi } from "@/components/IncludedAiAccount";
import { requestAccountSignIn } from "@/lib/add-account-request";
import { t } from "@/lib/i18n";
import { useStore, type InstanceInfo } from "@/state/store";

export type AiChoice = { kind: AccountKind; name: string } & (
  | { status: "ready" | "unavailable" }
  | { status: "signIn"; instanceId: string }
);

const ownAccount = (instance: InstanceInfo, kind: AccountKind) =>
  instance.driverKind === kind && (instance.access ?? "subscription") === "subscription"
  && !instance.readOnly && !instance.managed && !instance.policy;

export function aiChoices(instances: readonly InstanceInfo[]): AiChoice[] {
  return ACCOUNT_ENGINES.map(({ kind, name, defaultId }): AiChoice => {
    const own = instances.filter((instance) => ownAccount(instance, kind));
    if (own.some(engineReady)) return { kind, name, status: "ready" };
    const target = own.find((instance) => instance.instanceId === defaultId) ?? own[0];
    if (!target || (target.snapshot.state !== "available" && !target.install?.server)) return { kind, name, status: "unavailable" };
    return { kind, name, status: "signIn", instanceId: target.instanceId };
  });
}

function ChoiceRow({ choice }: { choice: AiChoice }) {
  return (
    <li data-ai-choice={choice.kind} data-status={choice.status} className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control">
        <AccountMark kind={choice.kind} size={18} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{choice.name}</span>
      {choice.status === "ready" ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary">
          <Check size={14} strokeWidth={2.25} aria-hidden="true" />
          {t("onboarding.engines.ready")}
        </span>
      ) : choice.status === "signIn" ? (
        <button
          type="button"
          onClick={() => requestAccountSignIn(choice.instanceId)}
          aria-label={t("onboarding.engines.signInTo", { name: choice.name })}
          className={pill}
        >
          {t("onboarding.engines.signIn")}
        </button>
      ) : (
        <span className="whitespace-nowrap text-[13px] text-ink-secondary">{t("onboarding.engines.unavailable")}</span>
      )}
    </li>
  );
}

export function AiChoices() {
  const { state, refreshInstances } = useStore();
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try {
      await refreshInstances();
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <ul data-ai-choices className="mt-6 divide-y divide-hairline/40 overflow-hidden rounded-xl bg-card">
        {includedAi(state.instances) && (
          <li data-ai-choice="free-ai">
            <IncludedAiAccount instances={state.instances} primary className="min-h-14 py-2" />
          </li>
        )}
        {aiChoices(state.instances).map((choice) => <ChoiceRow key={choice.kind} choice={choice} />)}
      </ul>
      <button
        type="button"
        onClick={() => void recheck()}
        disabled={checking}
        className="mt-6 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60"
      >
        {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {checking ? t("common.checking") : t("common.checkAgain")}
      </button>
    </>
  );
}
