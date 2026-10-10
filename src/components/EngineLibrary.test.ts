import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstanceInfo } from "@/state/store";
import { engineReady } from "./EngineLibrary";
import { CursorMark, HermesMark, InstanceProviderMark } from "./ProviderIcons";

const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available", authenticated: true },
  models: { default: "test", options: [] }, ...overrides,
});

describe("engine library", () => {
  it("keeps monochrome provider logos legible in light and dark skins", () => {
    for (const Mark of [CursorMark, HermesMark]) {
      const html = renderToStaticMarkup(createElement(Mark));
      expect(html).not.toContain("#F5F5F5");
      expect(html).toContain("ink");
    }
  });
  it("uses an instance icon without changing the driver's default mark", () => {
    const preset = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: instance({ icon: { kind: "preset", preset: "azure" } }) }));
    const custom = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: instance({ icon: { kind: "custom", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }) }));
    const fallback = renderToStaticMarkup(createElement(InstanceProviderMark, { instance: instance() }));
    expect(preset).toContain("#0089D6");
    expect(custom).toContain("data:image/png;base64,iVBORw0KGgo");
    expect(fallback).toContain("viewBox=\"0 0 256 257\"");
  });
  it("preserves readiness semantics without mistaking installation for sign-in", () => {
    expect(engineReady(instance())).toBe(true);
    expect(engineReady(instance({ snapshot: { state: "available" } }))).toBe(true);
    expect(engineReady(instance({ snapshot: { state: "available", authenticated: false } }))).toBe(false);
    expect(engineReady(instance({ access: "custom", snapshot: { state: "available", authenticated: false } }))).toBe(true);
    expect(engineReady(instance({ access: "custom", snapshot: { state: "unavailable", authenticated: true } }))).toBe(false);
  });

});
