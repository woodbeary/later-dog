// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";
const OLD_RUNTIME = /verified Antigravity runtime|Each Antigravity setup|90 seconds|MB download|I finished signing in|Send redirect|Install official Antigravity/;
const antigravity = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity", access: "subscription",
  models: { default: "", options: [] },
  snapshot: { state: "available", authenticated: false, version: "1.5.17" },
  authentication: { method: "paste-code", signOut: true },
  install: { command: { darwin: INSTALL, linux: INSTALL } },
  ...over,
});

let host: HTMLDivElement;
let root: Root;
function render(engine: InstanceInfo, laterdog: object | undefined): string {
  vi.stubGlobal("laterdog", laterdog);
  const store = { state: { config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: engine }) })));
  return host.innerHTML;
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Antigravity in engine setup", () => {
  it("signs in with Google by pasting the code or page address, in Google's words only", () => {
    const html = render(antigravity(), { platform: "darwin" });
    expect(html).toContain("Sign in to Antigravity");
    expect(html).toContain("Sign in with Google in your browser. Google then shows a code: paste the code or the page address here.");
    expect(html).toContain(">Sign in with Google</button>");
    expect(html).not.toMatch(/Claude|Anthropic/);
    expect(html).not.toMatch(OLD_RUNTIME);
  });

  it("offers Google's own installer command on a Mac without agy, and none of the retired runtime's words", () => {
    const legacy = antigravity({ snapshot: { state: "unavailable", reason: "agy is not installed." } });
    Object.assign(legacy.install!, { managed: { label: "Install official Antigravity", downloadBytes: 200_000_000 } });
    const html = render(legacy, { platform: "darwin", openInstallTerminal: vi.fn(async () => true) });
    expect(html).toContain("Install Antigravity");
    expect(html).toContain(INSTALL);
    expect(html).toContain("Open install in Terminal");
    expect(html).not.toMatch(OLD_RUNTIME);
  });
});
