import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdaterState } from "@/lib/updater";

const fixture = vi.hoisted(() => ({ state: null as UpdaterState | null }));
// As the real hook: no state without the desktop app's updater bridge.
vi.mock("@/lib/updater", () => ({ useUpdaterState: () => (window.laterdog?.updater ? fixture.state : null) }));
vi.mock("../lib/brand", () => ({ brand: () => ({ name: "later.dog" }) }));
import { AboutReleaseLine, ReleaseCheckRow, ReleaseNoticeCard, releaseChecksOff, releaseOffer } from "./ReleaseCheck";

const PAGE = "https://github.com/woodbeary/later-dog/releases/tag/v0.2.0";
const OFFERED: UpdaterState = { status: "idle", releaseCheck: "on", available: { version: "0.2.0", url: PAGE } };
/** This computer's page: the updater bridge, and the switch's own. */
const LOCAL_PAGE = { updater: {}, releaseCheck: { setEnabled: vi.fn(async (on: boolean) => on) } };

afterEach(() => vi.unstubAllGlobals());
function render<P extends object>(component: FunctionComponent<P>, state: UpdaterState | null, laterdog: object = LOCAL_PAGE, props = {} as P) {
  fixture.state = state;
  vi.stubGlobal("window", { laterdog });
  return renderToStaticMarkup(createElement(component, props));
}

it("offers a release only while the updater is otherwise idle", () => {
  expect(releaseOffer(OFFERED)).toEqual({ version: "0.2.0", url: PAGE });
  expect(releaseOffer({ ...OFFERED, status: "checking" })).toBeNull();
  expect(releaseOffer({ ...OFFERED, status: "error", message: "Could not check" })).toBeNull();
  expect(releaseOffer({ status: "idle", releaseCheck: "on" })).toBeNull();
  expect(releaseOffer(null)).toBeNull();
  expect(releaseChecksOff({ status: "idle", releaseCheck: "off" })).toBe(true);
  expect(releaseChecksOff({ status: "idle", releaseCheck: "on" })).toBe(false);
  // A build with an update feed has no release check at all.
  expect(releaseChecksOff({ status: "idle" })).toBe(false);
});

it("tells of a newer release once a version: a version put away stays away, a newer one comes back", () => {
  const card = render(ReleaseNoticeCard, OFFERED, LOCAL_PAGE, { release: OFFERED.available! });
  expect(card).toContain("later.dog 0.2.0 is available");
  expect(card).toContain("This build can&#x27;t update itself yet. Download the new version from GitHub.");
  expect(card).toContain("Download");
  expect(card).toContain("Later");

  vi.stubGlobal("localStorage", { getItem: (key: string) => (key === "laterdog.release-notice.dismissed" ? "0.2.0" : null), setItem: vi.fn() });
  expect(renderToStaticMarkup(createElement(ReleaseNoticeCard, { release: { version: "0.2.0", url: PAGE } }))).toBe("");
  expect(renderToStaticMarkup(createElement(ReleaseNoticeCard, { release: { version: "0.3.0", url: PAGE } }))).toContain("later.dog 0.3.0 is available");
});

it("About names the newer release beside its Download, and nothing otherwise", () => {
  const about = render(AboutReleaseLine, OFFERED);
  expect(about).toContain("later.dog 0.2.0 is available");
  expect(about).toContain(">Download</button>");
  expect(render(AboutReleaseLine, { status: "idle", releaseCheck: "on" })).toBe("");
  expect(render(AboutReleaseLine, { status: "downloaded", version: "0.2.0" })).toBe("");
  // a server's page the desktop app does not answer
  expect(render(AboutReleaseLine, OFFERED, {})).toBe("");
});

it("Settings → General has the switch on this computer's page of a build that checks GitHub", () => {
  const on = render(ReleaseCheckRow, OFFERED);
  expect(on).toContain("Check for new versions");
  expect(on).toContain("The request carries nothing about you.");
  expect(on).toMatch(/role="switch" aria-checked="true"/);
  expect(render(ReleaseCheckRow, { status: "idle", releaseCheck: "off" })).toMatch(/role="switch" aria-checked="false"/);
  // My Cloud's page reads updates but may not flip this computer's switch.
  expect(render(ReleaseCheckRow, OFFERED, { updater: {} })).toBe("");
  // An update feed's updater, or dev: nothing checks GitHub, so no switch.
  expect(render(ReleaseCheckRow, { status: "idle" })).toBe("");
  expect(render(ReleaseCheckRow, null)).toBe("");
});
