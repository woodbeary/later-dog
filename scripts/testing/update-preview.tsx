import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import type { UpdaterState } from "../../src/types/laterdog";
import "../../src/styles.css";

const VERSION = "0.3.4";
const NOTES = [
  "### Updates",
  "- **later.dog updates itself.** A small icon at the top of the sidebar shows when a new version is ready.",
  "- See [the release](https://github.com/woodbeary/later-dog/releases) for the full list.",
  "",
  "### Fixes",
  "- A picture you add while a dog works goes into the running turn, the same as words.",
].join("\n");

const PINNED: Record<string, UpdaterState> = {
  downloading: { status: "downloading", version: VERSION, percent: 42, notes: NOTES, installMode: "restart" },
  preparing: { status: "preparing", version: VERSION, notes: NOTES, installMode: "restart" },
  downloaded: { status: "downloaded", version: VERSION, notes: NOTES, installMode: "restart" },
  installing: { status: "installing", version: VERSION, installMode: "restart" },
  error: { status: "error", message: "getaddrinfo ENOTFOUND github.com" },
  stuck: { status: "error", retryable: false, message: "Not enough disk space to prepare the update. Free some space, then try again. Quit and reopen later.dog before trying the update again." },
  available: { status: "idle", releaseCheck: "on", available: { version: VERSION, url: `https://github.com/woodbeary/later-dog/releases/tag/v${VERSION}` } },
};

const listeners = new Set<(state: UpdaterState) => void>();
let current: UpdaterState = { status: "idle" };
let timer: ReturnType<typeof setInterval> | undefined;

function publish(next: UpdaterState) {
  current = next;
  for (const listener of listeners) listener(current);
}

function download() {
  clearInterval(timer);
  let percent = 0;
  publish({ status: "downloading", version: VERSION, notes: NOTES, installMode: "restart" });
  timer = setInterval(() => {
    percent += 4;
    if (percent < 100) return publish({ ...current, status: "downloading", percent });
    clearInterval(timer);
    publish({ ...current, status: "preparing", percent: undefined });
    setTimeout(() => publish({ ...current, status: "downloaded" }), 2000);
  }, 500);
}

const updater = {
  async check() {
    if (current.status === "idle" || current.status === "error") download();
  },
  async install() {
    publish({ ...current, status: "installing" });
    setTimeout(() => publish({ status: "idle" }), 5000);
  },
  onState(listener: (state: UpdaterState) => void) {
    listeners.add(listener);
    listener(current);
    return () => void listeners.delete(listener);
  },
};

Object.assign(window, { laterdog: { updater }, laterdogUpdatePreview: { publish, download, PINNED } });

const params = new URLSearchParams(location.search);
const pinned = params.get("update");
if (pinned && PINNED[pinned]) current = PINNED[pinned];
else if (pinned === "cycle") setTimeout(download, 1500);

setAnalyticsEnabled(false);
if (!params.has("onboarding")) setEmailGateDone("skipped");
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
