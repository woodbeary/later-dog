import { useEffect, useRef, useState } from "react";
import type { CloudAccountBridge, CloudAccountState } from "../../electron/cloud-account.mjs";
import { codeComplete, codeDigits, PRIVACY_URL, SIGN_IN_CODE_LENGTH, SIGN_IN_RESEND_SECONDS, signInProblem, TERMS_URL, validEmail, type SignInStep } from "@/lib/cloud-sign-in-view";
import { t } from "@/lib/i18n";
import { inputClass, QuietButton } from "@/components/onboarding/beats/shared";

type SignInBridge = Pick<CloudAccountBridge, "sendCode" | "verifyCode">;

function Agreement() {
  const link = (href: string, label: string) => (
    <a key={label} href={href} target="_blank" rel="noreferrer noopener" className="font-semibold text-ink underline-offset-2 hover:underline">{label}</a>
  );
  const parts = t("cloudSignIn.agreement").split(/(\{terms\}|\{privacy\})/);
  return (
    <p data-cloud-sign-in-agreement className="text-center text-[12px] leading-relaxed text-ink-secondary">
      {parts.map((part, index) => part === "{terms}" ? link(TERMS_URL, t("cloudSignIn.terms"))
        : part === "{privacy}" ? link(PRIVACY_URL, t("cloudSignIn.privacy")) : <span key={index}>{part}</span>)}
    </p>
  );
}

export function CloudSignInForm({ bridge, onSignedIn, onSkip, skipLabel, intro }: {
  bridge: SignInBridge;
  onSignedIn: (account: CloudAccountState) => void;
  onSkip?: () => void;
  skipLabel?: string;
  intro?: string;
}) {
  const [step, setStep] = useState<SignInStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const working = useRef(false);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const sendCode = async () => {
    const address = email.trim();
    if (working.current || !validEmail(address)) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.sendCode(address);
      if (result.ok) {
        setEmail(result.email);
        setCode("");
        setResendIn(SIGN_IN_RESEND_SECONDS);
        setStep("code");
      } else setProblem(t(signInProblem(result.code)));
    } catch {
      setProblem(t(signInProblem("unavailable")));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const verify = async (entered: string) => {
    if (working.current || !codeComplete(entered)) return;
    working.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.verifyCode(email, entered);
      if (result.ok) {
        onSignedIn(result.account);
        return;
      }
      setProblem(t(signInProblem(result.code)));
      setCode("");
      codeInput.current?.focus();
    } catch {
      setProblem(t(signInProblem("unavailable")));
      setCode("");
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const problemLine = problem ? <p role="alert" data-cloud-sign-in-problem className="text-center text-[13px] text-danger">{problem}</p> : null;
  const skip = onSkip ? <QuietButton type="button" onClick={onSkip} className="mt-1 self-center">{skipLabel ?? t("cloudSignIn.skip")}</QuietButton> : null;

  if (step === "code") {
    return (
      <div data-cloud-sign-in="code" className="flex flex-col gap-3">
        <div className="text-center">
          <p className="text-[16px] font-semibold text-ink">{t("cloudSignIn.codeTitle")}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("cloudSignIn.codeBody", { length: SIGN_IN_CODE_LENGTH, email })}</p>
        </div>
        <input
          ref={codeInput}
          autoFocus
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          data-keep-size
          aria-label={t("cloudSignIn.code")}
          value={code}
          maxLength={SIGN_IN_CODE_LENGTH + 4}
          disabled={busy}
          placeholder={"0".repeat(SIGN_IN_CODE_LENGTH)}
          onChange={(event) => {
            const digits = codeDigits(event.target.value);
            setCode(digits);
            if (codeComplete(digits)) void verify(digits);
          }}
          className={`${inputClass} text-center text-[24px] font-semibold tracking-[0.3em] tabular-nums`}
        />
        {problemLine}
        <div className="flex items-center justify-between">
          <QuietButton type="button" disabled={resendIn > 0 || busy} onClick={() => void sendCode()} className="disabled:opacity-50">
            {resendIn > 0 ? t("cloudSignIn.resendIn", { seconds: resendIn }) : t("cloudSignIn.resend")}
          </QuietButton>
          <QuietButton type="button" disabled={busy} onClick={() => { setStep("email"); setProblem(null); }}>{t("cloudSignIn.otherEmail")}</QuietButton>
        </div>
      </div>
    );
  }

  return (
    <div data-cloud-sign-in="email" className="flex flex-col gap-3">
      {intro && <p className="text-center text-[14px] text-ink-secondary">{intro}</p>}
      <input
        autoFocus
        type="email"
        autoComplete="email webauthn"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
        aria-label={t("cloudSignIn.email")}
        placeholder={t("cloudSignIn.emailPlaceholder")}
        value={email}
        disabled={busy}
        onChange={(event) => setEmail(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void sendCode(); }}
        className={inputClass}
      />
      <button
        type="button"
        data-primary=""
        disabled={busy || !validEmail(email)}
        aria-busy={busy}
        onClick={() => void sendCode()}
        className="w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-40"
      >
        {busy ? <span role="status">{t("cloudSignIn.sendingCode")}</span> : t("cloudSignIn.agree")}
      </button>
      <Agreement />
      {problemLine}
      {skip}
    </div>
  );
}
