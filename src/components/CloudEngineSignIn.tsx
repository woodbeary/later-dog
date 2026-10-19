import { AiChoices } from "@/components/AiChoices";
import { t } from "@/lib/i18n";

export function CloudEngineSignIn() {
  return (
    <main data-cloud-sign-in className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("cloudSignIn.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">{t("cloudSignIn.intro")}</p>
        <p role="note" className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudSignIn.limits")}</p>
        <AiChoices />
      </div>
    </main>
  );
}
