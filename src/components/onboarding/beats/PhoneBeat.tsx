import { useEffect } from "react";
import { PhoneSetupFlow } from "@/components/PhoneSetupFlow";
import { track } from "@/lib/analytics";
import type { BeatProps } from "./shared";

export function PhoneBeat({ onNext, onSkip, setMascot, bump }: BeatProps) {
  useEffect(() => {
    setMascot("sending");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="animate-rise flex min-h-0 flex-col">
      <PhoneSetupFlow
        variant="onboarding"
        compactHeader
        onSkip={() => {
          track("phone_setup_skipped");
          onSkip();
        }}
        onComplete={() => {
          track("phone_setup_completed");
          bump("celebrate");
          onNext();
        }}
      />
    </div>
  );
}
