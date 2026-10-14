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
import { UpdateDialogCard, UpdatePill, updateButtonPhase, updateErrorText, updatePillView, workingDogNames, workingWarning, type UpdateButtonPhase } from "./UpdateButton";

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.bots = [];
});

function pill(state: UpdaterState, window: object = { laterdog: { updater: {} } }, compact = false) {
  fixture.state = state;
  vi.stubGlobal("window", window);
  return renderToStaticMarkup(createElement(UpdatePill, { compact }));
}

function panel(state: UpdaterState, { working = [] as string[], pending = false } = {}) {
  vi.stubGlobal("window", { laterdog: { updater: {} } });
  const phase = updateButtonPhase(state) as UpdateButtonPhase;
  return renderToStaticMarkup(createElement(UpdateDialogCard, { phase, state, working, pending, onInstall: () => {}, onRetry: () => {}, onClose: () => {} }));
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

describe("the update pill", () => {
  it("is a blue Update button for a ready update on My Cloud's page, and absent from another server's page", () => {
    const ready = pill({ status: "downloaded", version: "0.3.4" }, { location: { origin: CLOUD }, laterdog: serverPageBridge(CLOUD, true) });
    expect(ready).toContain('data-update-pill="downloaded"');
    expect(ready).toContain('data-update-kind="update"');
    expect(ready).toContain("bg-update");
    expect(ready).toContain(">Update<");
    expect(ready).toContain('aria-label="later.dog 0.3.4 is ready"');
    const laterdog = serverPageBridge(OTHER, false) as { updater?: unknown };
    expect(laterdog.updater).toBeUndefined();
    expect(pill({ status: "downloaded", version: "0.3.4" }, { location: { origin: OTHER }, laterdog })).toBe("");
  });

  it("stays away while there is nothing to update", () => {
    expect(pill({ status: "idle" })).toBe("");
    expect(pill({ status: "checking" })).toBe("");
    expect(pill({ status: "idle", releaseCheck: "on" })).toBe("");
    expect(pill({ status: "idle", releaseCheck: "off" })).toBe("");
    expect(pill({ status: "downloaded", version: "0.3.4" }, {})).toBe("");
  });

  it("is quiet while it downloads: a plain line with the percent and a thin fill, nothing blue", () => {
    const html = pill({ status: "downloading", version: "0.3.4", percent: 42.4 });
    expect(html).toContain('data-update-kind="quiet"');
    expect(html).toContain("Downloading update… 42%");
    expect(html).toContain("width:42.4%");
    expect(html).not.toContain("bg-update");
    expect(html).toContain('disabled=""');
    expect(pill({ status: "downloading", version: "0.3.4" })).toContain("Downloading update…</span>");
    expect(pill({ status: "preparing", version: "0.3.4" })).toContain("Preparing update…");
  });

  it("marks a failure and a newer release to download", () => {
    const failed = pill({ status: "error", message: "boom" });
    expect(failed).toContain('data-update-kind="problem"');
    expect(failed).toContain("Update failed · Try again");
    expect(pill({ status: "error", retryable: false, message: "no space" })).toContain("Update failed</span>");
    const offered = pill({ status: "idle", releaseCheck: "on", available: { version: "0.3.4", url: "https://github.com/woodbeary/later-dog/releases/tag/v0.3.4" } });
    expect(offered).toContain('data-update-pill="available"');
    expect(offered).toContain("Download");
    expect(offered).toContain('aria-label="later.dog 0.3.4 is available"');
  });

  it("shrinks to an icon in the narrow sidebar, and only for a download or something to do", () => {
    const icon = pill({ status: "downloaded", version: "0.3.4" }, undefined, true);
    expect(icon).toContain("size-8");
    expect(icon).not.toContain(">Update<");
    expect(pill({ status: "preparing" }, undefined, true)).toBe("");
    expect(pill({ status: "downloading", percent: 5 }, undefined, true)).toContain('data-update-pill="downloading"');
  });

  it("maps every updater state to a phase and a pill", () => {
    expect(updateButtonPhase(null)).toBeNull();
    expect(updateButtonPhase({ status: "idle" })).toBeNull();
    expect(updateButtonPhase({ status: "checking" })).toBeNull();
    for (const status of ["downloading", "preparing", "downloaded", "installing", "handed-off", "error"] as const) {
      expect(updateButtonPhase({ status })).toBe(status);
    }
    expect(updatePillView("installing", { status: "installing" })).toMatchObject({ kind: "quiet", busy: true, label: "Restarting…" });
    expect(updatePillView("handed-off", { status: "handed-off" })).toMatchObject({ kind: "quiet", busy: false });
  });
});

describe("the update dialog", () => {
  it("names the version and keeps what's new, without unsafe markup or relative links", () => {
    const html = panel({ status: "downloaded", version: "0.3.4", notes: NOTES });
    expect(html).toContain("Update to later.dog 0.3.4?");
    expect(html).toContain("later.dog restarts to finish. Your dogs and chats are kept.");
    expect(html).toContain("What&#x27;s new");
    expect(html).toContain("Pictures</strong> show the moment a dog takes them.");
    expect(html).toContain('href="https://github.com/woodbeary/later-dog/releases"');
    expect(html).not.toContain('href="docs/guide.md"');
    expect(html).toContain("<span>the guide</span>");
    expect(html).not.toContain("<script");
    expect(html).toContain("Update and restart");
    expect(html).toContain("Later");
    expect(html).not.toContain("Try again");
  });

  it("warns on one line before a restart interrupts working dogs", () => {
    const one = panel({ status: "downloaded", version: "0.3.4" }, { working: ["Pepper"] });
    expect(one).toContain("Pepper is still working. Restarting now interrupts it.");
    expect(one).toContain("data-update-warning");
    expect(one).toContain("truncate");
    expect(panel({ status: "downloaded", version: "0.3.4" }, { working: ["Pepper", "Biscuit"] })).toContain("2 dogs are still working. Restarting now interrupts them.");
    expect(panel({ status: "downloaded", version: "0.3.4" })).not.toContain("still working");
    expect(panel({ status: "downloaded", version: "0.3.4", installMode: "handoff" }, { working: ["Pepper"] })).not.toContain("still working");
  });

  it("greys the restart out once it is pressed", () => {
    const html = panel({ status: "downloaded", version: "0.3.4" }, { pending: true });
    expect(html).toContain("Restarting…");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Update and restart");
  });

  it("keeps the restart busy and shows the recovery instruction", () => {
    const html = panel({ status: "installing", message: "Restart is taking longer than expected. Quit the app completely." });
    expect(html).toContain("Quit the app completely.");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Try again");
    expect(html).not.toContain(">Later<");
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
    expect(ready).not.toContain("Update and restart");
    const handed = panel({ status: "handed-off", installMode: "handoff", command: "sudo apt install ./later.dog.deb", terminalOpened: true });
    expect(handed).toContain("Paste it in the terminal that opened.");
    expect(handed).toContain("sudo apt install ./later.dog.deb");
  });

  it("offers a newer release's download where this build cannot update itself", () => {
    const html = panel({ status: "idle", releaseCheck: "on", available: { version: "0.3.4", url: "https://github.com/woodbeary/later-dog/releases/tag/v0.3.4" } });
    expect(html).toContain("Download");
    expect(html).not.toContain("Update and restart");
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
