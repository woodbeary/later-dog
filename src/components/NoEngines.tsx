import { useStore } from "@/state/store";
import { AiChoices } from "@/components/AiChoices";
import { t } from "@/lib/i18n";

export function NoEngines() {
  const { dispatch } = useStore();
  return (
    <main data-no-engines className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary">{t("noEngines.intro")}</p>
        <AiChoices />
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "general" })}
          className="mt-4 rounded-full bg-control px-3.5 py-1.5 text-[13px] text-ink hover:bg-control-hover"
        >
          {t("noEngines.more")}
        </button>
      </div>
    </main>
  );
}
