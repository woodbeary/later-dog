// Beat: the AI the dogs run on. later.dog leads with the four ways people bring their own subscription or endpoint —
// Claude, Codex, Cursor and any OpenAI-compatible server — one row each, straight on the card. Codex appears once even
// though it has two routes (the CLI sign-in and the ChatGPT plan): a person signs in to Codex, not to a route. An
// engine that needs work opens its setup inline under its row, with the driver's own instructions for this platform.
// Every other engine is named once under "Coming soon" unless it is already set up, in which case it is listed as
// the working engine it is. Check again is an icon: people often install from a terminal and come back.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Plug, RefreshCw } from "lucide-react";
import { EngineSetup } from "@/components/EngineSetup";
import { engineReady } from "@/components/EngineLibrary";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { onboardingProviders, type OnboardingProductId, type OnboardingProvider } from "@/lib/onboarding";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

const PRODUCT_NAMES = {
  claude: "onboarding.engines.product.claude",
  codex: "onboarding.engines.product.codex",
  cursor: "onboarding.engines.product.cursor",
  openaiCompat: "onboarding.engines.product.openaiCompat",
} as const satisfies Record<OnboardingProductId, string>;

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ready ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
      )}
    >
      <span className={cn("size-1.5 rounded-full", ready ? "bg-success" : "bg-warning")} aria-hidden="true" />
      {ready ? t("onboarding.engines.ready") : t("onboarding.engines.needsSetup")}
    </span>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className="animate-rise flex items-center gap-3 py-3" style={staggerIndex(index)} aria-hidden="true">
      <span className="size-5 rounded-md bg-raised" />
      <span className="h-3 w-32 rounded bg-raised" />
      <span className="ml-auto h-4 w-14 rounded-full bg-raised" />
    </div>
  );
}

function ProviderRow({ provider, open, onToggle, index }: { provider: OnboardingProvider<InstanceInfo>; open: boolean; onToggle: () => void; index: number }) {
  const { instance } = provider;
  const ready = instance ? engineReady(instance) : false;
  const version = ready && instance?.snapshot.version ? instance.snapshot.version.split(" ")[0] : null;
  const mark = provider.id === "openaiCompat" || !instance
    ? <Plug size={18} strokeWidth={1.75} className="text-ink-secondary" aria-hidden="true" />
    : <InstanceProviderMark instance={instance} size={20} />;
  const name = provider.name ?? t(PRODUCT_NAMES[provider.id as OnboardingProductId]);
  const row = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center">{mark}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[14px] font-medium text-ink">{name}</span>
        {version && <span className="shrink-0 text-[11.5px] tabular-nums text-ink-secondary">{version}</span>}
      </span>
      <StatusPill ready={ready} />
    </>
  );
  return (
    <div className="animate-rise" style={staggerIndex(index)}>
      {ready || !instance ? (
        <div className="flex items-center gap-3 py-3">{row}</div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-raised/50"
        >
          {row}
          <ChevronDown size={14} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform duration-200", open && "rotate-180")} />
        </button>
      )}
      {open && instance && !ready && (
        <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} unframed className="pb-3" />
      )}
    </div>
  );
}

export function EnginesBeat({ onNext, setMascot, bump }: BeatProps & { hosted?: boolean; onOpenOrganisation?: () => void }) {
  const { state, dispatch } = useStore();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const latestRequest = useRef(0);
  // EngineSetup updates the shared inventory after sign-in; keep that source of truth.
  const instances = loaded || state.instances.length ? state.instances : null;
  const [checking, setChecking] = useState(false);
  // Every setup starts closed; a row opens its own on click.
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setChecking(true);
    try {
      const d = await api("/api/instances", { signal: AbortSignal.timeout(10_000) });
      if (request !== latestRequest.current) return;
      dispatch({ type: "instances", instances: d.instances ?? [] });
      setLoaded(true);
      setFailed(false);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setChecking(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh();
    return () => {
      latestRequest.current++;
    };
  }, [refresh]);

  const { featured, working, comingSoon } = onboardingProviders(instances ?? [], engineReady);
  const anyReady = instances !== null && (featured.some((p) => p.instance && engineReady(p.instance)) || working.length > 0);

  // The guide searches while the harness answers, then looks proud or curious.
  useEffect(() => {
    if (instances === null) {
      setMascot("searching");
      return;
    }
    if (anyReady) {
      setMascot("proud");
      bump("success");
    } else {
      setMascot("curious");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instances === null, anyReady]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="animate-rise mt-1 flex items-start justify-between gap-3">
        <p className="text-[14px] leading-relaxed text-ink-secondary">{t("onboarding.engines.intro")}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={checking}
          aria-label={t("common.checkAgain")}
          title={t("common.checkAgain")}
          className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
        </button>
      </div>
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.engines.error")}</p>}

      <div className="mt-3 min-h-0 divide-y divide-hairline/40 overflow-y-auto border-y border-hairline/40 [scrollbar-width:thin]" aria-live="polite">
        {instances === null
          ? !failed && [0, 1, 2, 3].map((i) => <SkeletonRow key={i} index={i} />)
          : [...featured, ...working].map((provider, i) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                index={i}
                open={open === provider.id}
                onToggle={() => setOpen(open === provider.id ? null : provider.id)}
              />
            ))}
      </div>
      {instances !== null && comingSoon.length > 0 && (
        <p className="animate-rise mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          {t("onboarding.engines.comingSoon", { names: comingSoon.join(", ") })}
        </p>
      )}

      <PrimaryButton onClick={onNext} className="mt-5">
        {t("onboarding.continue")}
      </PrimaryButton>
    </div>
  );
}
