import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { pill, pollSignedIn } from "@/components/AccountsPanel";
import { claudeSignInLink } from "@/components/ClaudeSignIn";
import { chatgptPlanLink, deviceFlowUnavailable, type DeviceSignInStatus } from "@/components/DeviceSignIn";
import { engineReady } from "@/components/EngineLibrary";
import { ClaudeMark, CodexMark } from "@/components/ProviderIcons";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ONBOARDING_ACCOUNT_IDS, onboardingAccounts, type OnboardingAccount, type OnboardingAccountId } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

const NAMES = {
  claude: "onboarding.engines.product.claude",
  chatgpt: "onboarding.engines.product.chatgpt",
} as const satisfies Record<OnboardingAccountId, LocaleKey>;

const MARKS = { claude: ClaudeMark, chatgpt: CodexMark } as const satisfies Record<OnboardingAccountId, typeof ClaudeMark>;

const SIGNED_IN_CHECKS = [0, 500, 1000, 2000, 4000];

type Flow =
  | { step: "working" }
  | { step: "browser" | "code"; instanceId: string; flowId: string; link: string; sending?: boolean };

type Report = (id: OnboardingAccountId, text: string | null) => void;

function AccountRow({ id, account, report }: { id: OnboardingAccountId; account: OnboardingAccount | null; report: Report }) {
  const { dispatch, refreshModels } = useStore();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [code, setCode] = useState("");
  const [poll, setPoll] = useState(0);
  const mounted = useRef(true);
  const name = t(NAMES[id]);
  const Mark = MARKS[id];
  const ready = account?.status === "ready";
  const active = ready ? null : flow;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fail = (text = t("onboarding.engines.failed", { name })) => {
    if (!mounted.current) return;
    setFlow(null);
    setCode("");
    report(id, text);
  };

  const finish = async (instanceId: string) => {
    if (mounted.current) setFlow({ step: "working" });
    const signedIn = await pollSignedIn(() => false, async () => {
      try {
        const { instances } = await api<{ instances: InstanceInfo[] }>("/api/instances");
        dispatch({ type: "instances", instances });
        return instances.some((instance) => instance.instanceId === instanceId && engineReady(instance));
      } catch {
        return false;
      }
    }, SIGNED_IN_CHECKS);
    void refreshModels(instanceId).catch(() => {});
    if (!signedIn) fail();
    else if (mounted.current) setFlow(null);
  };

  const settle = async (instanceId: string, auth: DeviceSignInStatus) => {
    if (auth.phase === "succeeded") await finish(instanceId);
    else fail();
  };

  const signIn = async () => {
    if (account?.status !== "signIn" || flow) return;
    const { instanceId, install } = account;
    const base = `/api/instances/${encodeURIComponent(instanceId)}`;
    setFlow({ step: "working" });
    report(id, null);
    if (install) {
      try {
        const { instances } = await api<{ instances?: InstanceInfo[] }>(`${base}/install`, { method: "POST" });
        if (instances) {
          dispatch({ type: "instances", instances });
          if (onboardingAccounts(instances, engineReady).some((row) => row.id === id && row.status === "ready")) {
            if (mounted.current) setFlow(null);
            return;
          }
        }
      } catch {
        fail(t("onboarding.engines.setupFailed", { name }));
        return;
      }
    }
    try {
      const { auth } = await api<{ auth: DeviceSignInStatus }>(`${base}/auth/start`, { method: "POST" });
      if (auth.phase === "succeeded") {
        await finish(instanceId);
        return;
      }
      const link = id === "claude" ? claudeSignInLink(auth.authorizationUrl) : chatgptPlanLink(auth.authorizationUrl);
      if (auth.phase !== "waiting" || !auth.flowId || !link) {
        fail();
        return;
      }
      if (!mounted.current) return;
      setFlow({ step: id === "claude" ? "code" : "browser", instanceId, flowId: auth.flowId, link });
      void openExternalLink(link).catch(() => {});
    } catch {
      fail();
    }
  };

  const submit = async (value: string) => {
    const pasted = value.trim();
    if (flow?.step !== "code" || flow.sending || !pasted) return;
    const current = flow;
    const base = `/api/instances/${encodeURIComponent(current.instanceId)}/auth`;
    const status = async () => (await api<{ auth: DeviceSignInStatus }>(`${base}/status?flowId=${encodeURIComponent(current.flowId)}`)).auth;
    setFlow({ ...current, sending: true });
    report(id, null);
    let auth: DeviceSignInStatus;
    try {
      const completed = await api<{ auth?: DeviceSignInStatus }>(`${base}/complete`, {
        method: "POST",
        body: JSON.stringify({ flowId: current.flowId, code: pasted }),
      });
      auth = completed.auth ?? (await status());
    } catch {
      try {
        auth = await status();
      } catch {
        fail();
        return;
      }
    }
    if (auth.phase !== "waiting") {
      await settle(current.instanceId, auth);
      return;
    }
    if (!mounted.current) return;
    setFlow({ ...current, sending: false });
    setCode("");
    report(id, t("onboarding.engines.badCode"));
  };

  useEffect(() => {
    if (!active || active.step === "working" || active.sending) return;
    const { instanceId, flowId } = active;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ auth: DeviceSignInStatus }>(`/api/instances/${encodeURIComponent(instanceId)}/auth/status?flowId=${encodeURIComponent(flowId)}`, { signal: controller.signal })
        .then(({ auth }) => {
          if (controller.signal.aborted) return;
          if (auth.phase === "waiting") setPoll((count) => count + 1);
          else void settle(instanceId, auth);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (deviceFlowUnavailable(cause)) fail();
          else setPoll((count) => count + 1);
        });
    }, 2_000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, poll]);

  const codeFlow = active?.step === "code" ? active : null;
  const reopen = active && active.step !== "working" && !active.sending ? active.link : null;
  let slot: ReactNode;
  if (!account) {
    slot = <Loader2 size={16} aria-hidden="true" className="animate-spin text-ink-tertiary" />;
  } else if (ready) {
    slot = (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary">
        <Check size={14} strokeWidth={2.25} aria-hidden="true" />
        {t("onboarding.engines.ready")}
      </span>
    );
  } else if (active) {
    slot = (
      <button
        type="button"
        aria-disabled={!reopen}
        title={reopen ? t("onboarding.engines.openAgain") : undefined}
        onClick={() => {
          if (reopen) void openExternalLink(reopen).catch(() => {});
        }}
        className={cn(pill, "inline-flex items-center gap-1.5", !reopen && "pointer-events-none")}
      >
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        {t("onboarding.engines.signingIn")}
      </button>
    );
  } else if (account.status === "signIn") {
    slot = (
      <button type="button" onClick={() => void signIn()} aria-label={t("onboarding.engines.signInTo", { name })} className={pill}>
        {t("onboarding.engines.signIn")}
      </button>
    );
  } else {
    slot = <span className="whitespace-nowrap text-[13px] text-ink-secondary">{t("onboarding.engines.unavailable")}</span>;
  }

  return (
    <li data-onboarding-account={id} className="flex h-14 items-center gap-3 px-4">
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control">
        <Mark size={18} />
      </span>
      {codeFlow ? (
        <input
          autoFocus
          value={code}
          readOnly={codeFlow.sending}
          onChange={(event) => setCode(event.target.value)}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text").trim();
            if (!pasted) return;
            event.preventDefault();
            setCode(pasted);
            void submit(pasted);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void submit(code);
          }}
          aria-label={t("onboarding.engines.pasteCode")}
          placeholder={t("onboarding.engines.pasteCode")}
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-hairline/40 bg-inset px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent-border read-only:opacity-60"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{name}</span>
      )}
      <span className={cn("flex shrink-0 items-center justify-end", !codeFlow && "min-w-[7.5rem]")}>{slot}</span>
    </li>
  );
}

export function EnginesBeat({ onNext, setMascot, bump }: BeatProps & { hosted?: boolean; onOpenOrganisation?: () => void }) {
  const { state, dispatch } = useStore();
  const [loaded, setLoaded] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [message, setMessage] = useState<{ id: OnboardingAccountId; text: string } | null>(null);

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
  const anyReady = accounts?.some((account) => account.status === "ready") ?? false;

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
        {t("onboarding.engines.subtitle")}
      </p>
      <ul
        aria-busy={loading}
        className="animate-rise mt-4 min-h-0 divide-y divide-hairline/40 overflow-y-auto rounded-xl bg-card [scrollbar-width:thin]"
        style={staggerIndex(1)}
      >
        {ONBOARDING_ACCOUNT_IDS.map((id) => (
          <AccountRow key={id} id={id} account={accounts?.find((account) => account.id === id) ?? null} report={report} />
        ))}
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
