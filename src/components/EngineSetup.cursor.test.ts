// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { deviceSignInProvider } from "./DeviceSignIn";
import { EngineSetup } from "./EngineSetup";

const CURL = "curl https://cursor.com/install -fsS | bash";
const signedOutCursor: InstanceInfo = {
  instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor",
  models: { default: "auto", options: [] },
  snapshot: { state: "available", authenticated: false, version: "2026.10.16" },
  authentication: { method: "device-code", signOut: true },
  install: { command: { darwin: CURL, linux: CURL }, docsUrl: "https://cursor.com/docs/cli/installation", signInCommand: "cursor-agent login" },
};

let host: HTMLDivElement;
let root: Root;
function render(engine: InstanceInfo, laterdog: object | undefined, cloudHome = false): string {
  vi.stubGlobal("laterdog", laterdog);
  const store = { state: { config: cloudHome ? { cloudHome: true } : {} }, dispatch: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
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

describe("a signed-out Cursor dog whose server offers a device sign-in", () => {
  it("has no in-app sign-in copy yet", () => {
    expect(deviceSignInProvider("cursorAgent")).toBeNull();
    expect(deviceSignInProvider("codex")).toBe("codex");
    expect(deviceSignInProvider("grokAgent")).toBe("grok");
  });

  it.each([
    ["the desktop app's own window", { platform: "darwin", openInstallTerminal: vi.fn(async () => true), remoteClient: { active: false } }, false],
    ["a server's page in a browser", undefined, false],
    ["My Cloud", undefined, true],
  ] as const)("shows the cursor-agent login command and no ChatGPT copy in %s", (_where, laterdog, cloudHome) => {
    const html = render(signedOutCursor, laterdog, cloudHome);
    expect(html).toContain("cursor-agent login");
    expect(html).not.toContain("data-device-sign-in");
    expect(html).not.toMatch(/ChatGPT|OpenAI|Codex/);
  });
});
