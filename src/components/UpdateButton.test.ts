import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: { status: "idle" } as UpdaterState, bots: [] as Array<{ name: string; busy?: boolean; activity?: string; tasks?: Array<{ busy?: boolean; activity?: string }> }> }));
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.laterdog?.updater ? fixture.state : null) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: fixture.bots }, dispatch: () => {} }) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
import { UpdateButton, UpdatePanel, updateButtonPhase, updateErrorText, workingDogNames, workingWarning, type UpdateButtonPhase } from "./UpdateButton";

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.bots = [];
});

function button(state: UpdaterState, window: object = { laterdog: { updater: {} } }) {
  fixture.state = state;
  vi.stubGlobal("window", window);
  return renderToStaticMarkup(createElement(UpdateButton));
}

function panel(state: UpdaterState, { working = [] as string[], pending = false } = {}) {
  vi.stubGlobal("window", { laterdog: { updater: {} } });
  const phase = updateButtonPhase(state) as UpdateButtonPhase;
  return renderToStaticMarkup(createElement(UpdatePanel, { phase, state, working, pending, onInstall: () => {}, onRetry: () => {}, onClose: () => {} }));
}

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://home-7f3k2.fly.dev";
const OTHER = "https://bots.example.test";
function serverPageBridge(origin: string, answered: boolean) {
  let bridge: unknown;
  vm.runInNewContext(readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--laterdog-local-origin=${LOCAL}`] },
    location: { origin }, navigator: { userActivation: { isActive: false } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { bridge = value; } },
      ipcRenderer: {
        on() {}, removeListener() {}, send() {}, invoke: () => Promise.resolve({ status: "idle" }),
        sendSync: (channel: string) => channel === "update:offered" && answered,
      },
    }),
  });
  return bridge;
}

const NOTES = "### Fixes\n- **Pictures** show the moment a dog takes them.\n- See [the guide](docs/guide.md) and [the release](https://github.com/woodbeary/later-dog/releases).\n\n<script>alert(1)</script>";

describe("the update icon", () => {
  it("appears for a ready update on My Cloud's page and is absent from another server's page", () => {
    const ready = button({ status: "downloaded", version: "0.3.4" }, { location: { origin: CLOUD }, laterdog: serverPageBridge(CLOUD, true) });
    expect(ready).toContain('data-update-button="downloaded"');
    expect(ready).toContain('aria-label="later.dog 0.3.4 is ready"');
    expect(ready).toContain('aria-haspopup="dialog"');
    const laterdog = serverPageBridge(OTHER, false) as { updater?: unknown };
    expect(laterdog.updater).toBeUndefined();
    expect(button({ status: "downloaded", version: "0.3.4" }, { location: { origin: OTHER }, laterdog })).toBe("");
  });

  it("stays away while there is nothing to update", () => {
    expect(button({ status: "idle" })).toBe("");
    expect(button({ status: "checking" })).toBe("");
    expect(button({ status: "idle", releaseCheck: "on" })).toBe("");
    expect(button({ status: "idle", releaseCheck: "off" })).toBe("");
    expect(button({ status: "downloaded", version: "0.3.4" }, {})).toBe("");
  });

  it("shows a download's progress as a ring, and a spinner before the first percent", () => {
    const ring = button({ status: "downloading", version: "0.3.4", percent: 40 });
    expect(ring).toContain('data-update-button="downloading"');
    expect(ring).toContain("stroke-dashoffset");
    expect(ring).toContain('aria-label="Downloading later.dog 0.3.4"');
    expect(button({ status: "downloading", version: "0.3.4" })).toContain("animate-spin");
  });

  it("marks a failure and a newer release to download", () => {
    expect(button({ status: "error", message: "boom" })).toContain('data-update-button="error"');
    const offered = button({ status: "idle", releaseCheck: "on", available: { version: "0.3.4", url: "https://github.com/woodbeary/later-dog/releases/tag/v0.3.4" } });
    expect(offered).toContain('data-update-button="available"');
    expect(offered).toContain('aria-label="later.dog 0.3.4 is available"');
  });

  it("maps every updater state to the icon's phase", () => {
    expect(updateButtonPhase(null)).toBeNull();
    expect(updateButtonPhase({ status: "idle" })).toBeNull();
    expect(updateButtonPhase({ status: "checking" })).toBeNull();
    for (const status of ["downloading", "preparing", "downloaded", "installing", "handed-off", "error"] as const) {
      expect(updateButtonPhase({ status })).toBe(status);
    }
  });
});

describe("the update popover", () => {
  it("offers the restart with what's new, and keeps unsafe markup and relative links out", () => {
    const html = panel({ status: "downloaded", version: "0.3.4", notes: NOTES });
    expect(html).toContain("later.dog 0.3.4 is ready");
    expect(html).toContain("Restart later.dog to finish. Your dogs and chats are kept.");
    expect(html).toContain("What&#x27;s new");
    expect(html).toContain("<strong");
    expect(html).toContain("Pictures</strong> show the moment a dog takes them.");
    expect(html).toContain('href="https://github.com/woodbeary/later-dog/releases"');
    expect(html).not.toContain('href="docs/guide.md"');
    expect(html).toContain("<span>the guide</span>");
    expect(html).not.toContain("<script");
    expect(html).toContain("Restart to update");
    expect(html).toContain("Later");
    expect(html).not.toContain("Try again");
  });

  it("warns before a restart interrupts working dogs", () => {
    expect(panel({ status: "downloaded", version: "0.3.4" }, { working: ["Pepper"] })).toContain("Pepper is still working. Restarting now interrupts it.");
    expect(panel({ status: "downloaded", version: "0.3.4" }, { working: ["Pepper", "Biscuit"] })).toContain("2 dogs are still working. Restarting now interrupts them.");
    expect(panel({ status: "downloaded", version: "0.3.4" })).not.toContain("still working");
    expect(panel({ status: "downloaded", version: "0.3.4", installMode: "handoff" }, { working: ["Pepper"] })).not.toContain("still working");
  });

  it("greys the restart out once it is pressed", () => {
    const html = panel({ status: "downloaded", version: "0.3.4" }, { pending: true });
    expect(html).toContain("Restarting…");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Restart to update");
  });

  it("shows the download's progress and what's new while it downloads", () => {
    const html = panel({ status: "downloading", version: "0.3.4", percent: 42.4, notes: "- Faster pictures" });
    expect(html).toContain("42% done. Keep working. Nothing restarts until you say so.");
    expect(html).toContain("width:42.4%");
    expect(html).toContain("Faster pictures");
    expect(html).toContain("Close");
    expect(html).not.toContain("Restart to update");
    expect(panel({ status: "downloading", version: "0.3.4" })).toContain("Starting download…");
  });

  it("keeps the restart busy and shows the recovery instruction", () => {
    const html = panel({ status: "installing", message: "Restart is taking longer than expected. Quit the app completely." });
    expect(html).toContain("Restarting to update…");
    expect(html).toContain("Quit the app completely.");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Try again");
    expect(html).not.toContain(">Close<");
  });

  it("names a failure plainly and offers a retry only when one can work", () => {
    const retry = panel({ status: "error", message: "Native staging failed\nat Object.<anonymous>" });
    expect(retry).toContain("The update didn&#x27;t finish");
    expect(retry).toContain("Native staging failed");
    expect(retry).not.toContain("Object.&lt;anonymous&gt;");
    expect(retry).toContain("Try again");
    const stuck = panel({ status: "error", retryable: false, message: "Not enough disk space to prepare the update. Free some space, then try again. Quit and reopen later.dog before trying the update again." });
    expect(stuck).toContain("Free some space");
    expect(stuck).toContain("Quit and reopen later.dog");
    expect(stuck).not.toContain("Try again</button>");
    expect(stuck).toContain("Close");
  });

  it("keeps the system package hand-off without promising a restart", () => {
    const ready = panel({ status: "downloaded", version: "0.3.4", installMode: "handoff" });
    expect(ready).toContain("Copy the install command and open a terminal.");
    expect(ready).toContain("Install");
    expect(ready).not.toContain("Restart to update");
    const handed = panel({ status: "handed-off", installMode: "handoff", command: "sudo apt install ./later.dog.deb", terminalOpened: true });
    expect(handed).toContain("Finish the update in your terminal");
    expect(handed).toContain("Paste it in the terminal that opened.");
    expect(handed).toContain("sudo apt install ./later.dog.deb");
  });

  it("offers a newer release's download where this build cannot update itself", () => {
    const html = panel({ status: "idle", releaseCheck: "on", available: { version: "0.3.4", url: "https://github.com/woodbeary/later-dog/releases/tag/v0.3.4" } });
    expect(html).toContain("later.dog 0.3.4 is available");
    expect(html).toContain("This build can&#x27;t update itself yet.");
    expect(html).toContain("Download");
    expect(html).toContain("Later");
    expect(html).not.toContain("Restart to update");
  });
});

describe("update helpers", () => {
  it("finds every dog with a turn running, in its chats too", () => {
    expect(workingDogNames([
      { name: "Pepper", busy: true },
      { name: "Biscuit", activity: "working" },
      { name: "Churro", tasks: [{ activity: "idle" }, { busy: true }] },
      { name: "Waffles", activity: "waiting-on-you", tasks: [{ activity: "idle" }] },
      { name: "Toast" },
    ] as never)).toEqual(["Pepper", "Biscuit", "Churro"]);
    expect(workingWarning([])).toBeNull();
  });

  it("turns updater errors into one readable line", () => {
    expect(updateErrorText(undefined)).toBe("Something went wrong.");
    expect(updateErrorText("net::ERR_INTERNET_DISCONNECTED")).toBe("Couldn't reach the update server. Check your connection and try again.");
    expect(updateErrorText("getaddrinfo ENOTFOUND github.com")).toBe("Couldn't reach the update server. Check your connection and try again.");
    expect(updateErrorText(`${"x".repeat(300)}\nstack`)).toHaveLength(200);
  });
});
