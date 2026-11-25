import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { StoreProvider, type Bot } from "../../src/state/store";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { AccountsPanel } from "../../src/components/AccountsPanel";
import { AddAccountHost } from "../../src/components/AddAccountHost";
import { ModelPicker } from "../../src/components/ModelPicker";
import { applySkin } from "../../src/lib/skins";
import { t } from "../../src/lib/i18n";

const params = new URLSearchParams(location.search);
applySkin(params.get("skin") === "midnight" ? "midnight" : "daylight");
document.documentElement.dataset.reducedMotion = "true";

const bot: Bot = {
  id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "antigravity", model: "gemini-4-hydrogen", effort: "xhigh" },
};

function Preview() {
  if (params.get("view") === "simple") {
    return (
      <main className="flex h-screen flex-col bg-app p-4">
        <div data-preview-settings className="rounded-xl bg-card px-3 py-2">
          <ModelPicker bot={bot} contained label={<span className="text-[14px] text-ink">{t("botSettings.simple.runsOn")}</span>} />
        </div>
      </main>
    );
  }
  if (params.get("view") === "picker") {
    return (
      <main className="flex h-screen flex-col justify-end bg-app p-4">
        <div data-preview-composer className="rounded-[22px] border border-hairline/60 bg-composer px-3 py-2">
          <ModelPicker bot={bot} threadId={bot.threadId} above part="chat" />
        </div>
      </main>
    );
  }
  return (
    <main className="min-h-screen bg-app p-5">
      <div data-preview-accounts className="mx-auto max-w-[560px]">
        <AccountsPanel />
      </div>
      <AddAccountHost />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
