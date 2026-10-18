import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { signedInModelInstances, splitEngineRail } from "./engine-rail";

describe("splitEngineRail", () => {
  it("groups sign-in plans, pasted provider keys and Local engines", () => {
    const { subscription, api, custom } = splitEngineRail([
      { access: "subscription", instanceId: "claude" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "api", instanceId: "mistral" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(subscription.map((row) => row.instanceId)).toEqual(["claude", "grok"]);
    expect(api.map((row) => row.instanceId)).toEqual(["mistral"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "claude" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });
});

describe("signedInModelInstances", () => {
  const cloud = { id: "cloud-model", label: "Cloud model" };
  const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    access: "subscription",
    snapshot: { state: "available", authenticated: true },
    models: { default: cloud.id, options: [cloud] },
    ...overrides,
  });

  it("lists signed-in Claude, ChatGPT, Grok and Cursor accounts and the included AI", () => {
    const engines = [
      instance({ instanceId: "claude", driverKind: "claudeAgent" }),
      instance(),
      instance({ instanceId: "grok", driverKind: "grokAgent" }),
      instance({ instanceId: "cursor", driverKind: "cursorAgent" }),
      instance({ instanceId: "laterdogAi", driverKind: "laterdogAi" }),
      instance({ instanceId: "laterdogGrok", driverKind: "laterdogGrok" }),
    ];
    expect(signedInModelInstances(engines)).toEqual(engines);
  });

  it("leaves out signed-out, missing and empty accounts and engines outside the shown list", () => {
    const ready = instance();
    const signedOut = instance({ instanceId: "grok", driverKind: "grokAgent", snapshot: { state: "available", authenticated: false } });
    const missing = instance({ instanceId: "cursor", driverKind: "cursorAgent", snapshot: { state: "unavailable", reason: "cursor-agent not found" } });
    const freeNotStarted = instance({ instanceId: "laterdogAi", driverKind: "laterdogAi", snapshot: { state: "unavailable", reason: "Start the free trial to use the free models." } });
    const empty = instance({ instanceId: "empty", models: { default: cloud.id, options: [] } });
    const extra = instance({ instanceId: "opencode", driverKind: "opencode" });
    const local = instance({ instanceId: "ollama", driverKind: "openai-compat", access: "custom" });

    expect(signedInModelInstances([signedOut, missing, freeNotStarted, empty, ready, extra, local])).toEqual([ready]);
  });

  it("treats a subscription account whose sign-in is still unknown as signed in", () => {
    const unknown = instance({ snapshot: { state: "available" } });
    expect(signedInModelInstances([unknown])).toEqual([unknown]);
  });

  it("keeps a ChatGPT plan with no catalog yet", () => {
    const plan = instance({ instanceId: "chatgpt", snapshot: { state: "available", authenticated: true, chatgptPlan: true }, models: { default: "", options: [] } });
    expect(signedInModelInstances([plan])).toEqual([plan]);
  });

  it("lists an API key engine only once its key is saved", () => {
    const saved = instance({ instanceId: "xai", driverKind: "grok", access: "api" });
    const unsaved = instance({ instanceId: "openai", driverKind: "openai-compat", access: "api", snapshot: { state: "available" } });
    const rejected = instance({ instanceId: "claudeApi", driverKind: "claudeAgent", access: "api", snapshot: { state: "available", authenticated: false } });
    expect(signedInModelInstances([saved, unsaved, rejected])).toEqual([saved]);
  });

  it("always keeps the engine the dog runs on, signed out, missing or empty", () => {
    const signedOut = instance({ instanceId: "grok", driverKind: "grokAgent", snapshot: { state: "available", authenticated: false } });
    const missing = instance({ instanceId: "missing", snapshot: { state: "unavailable", reason: "`codex` CLI not found" } });
    const extra = instance({ instanceId: "opencode", driverKind: "opencode", models: { default: cloud.id, options: [] } });
    const ready = instance({ instanceId: "ready" });

    expect(signedInModelInstances([signedOut, ready], "grok")).toEqual([signedOut, ready]);
    expect(signedInModelInstances([missing, ready], "missing")).toEqual([missing, ready]);
    expect(signedInModelInstances([extra, ready], "opencode")).toEqual([extra, ready]);
    expect(signedInModelInstances([missing, ready], "")).toEqual([ready]);
  });

  it("judges each Claude account on its own and preserves account order", () => {
    const claude = (id: string, snapshot: InstanceInfo["snapshot"]) => instance({ instanceId: id, driverKind: "claudeAgent", displayName: id, snapshot });
    const personal = claude("Personal", { state: "available", authenticated: false });
    const work = claude("Work", { state: "available", authenticated: true });
    const missing = claude("Missing", { state: "unavailable", reason: "`claude` CLI not found" });
    const other = claude("Other", { state: "available", authenticated: true });

    expect(signedInModelInstances([personal, work, missing, other])).toEqual([work, other]);
    expect(signedInModelInstances([personal, work, missing, other], "Personal")).toEqual([personal, work, other]);
  });

  it("returns the catalog's own entries and leaves them intact so saved models keep their labels", () => {
    const signedIn = instance();
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable" } });
    const catalog = [signedIn, unavailable];
    const before = structuredClone(catalog);
    for (const engine of catalog) {
      for (const option of engine.models.options) Object.freeze(option);
      Object.freeze(engine.models.options);
      Object.freeze(engine.models);
      Object.freeze(engine.snapshot);
      Object.freeze(engine);
    }
    Object.freeze(catalog);

    const configured = signedInModelInstances(catalog);

    expect(configured).toEqual([signedIn]);
    expect(configured[0]).toBe(signedIn);
    expect(catalog).toEqual(before);
  });
});

describe("Claude in the picker when Claude Code is signed out or not found", () => {
  const official = [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5", label: "Sonnet 5" }];
  const claude = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
    instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", snapshot,
    models: { default: "claude-opus-5-5", options: official },
  });

  it("shows a signed-in Claude", () => {
    expect(signedInModelInstances([claude({ state: "available", authenticated: true })])).toHaveLength(1);
  });

  it("keeps a signed-out Claude only while the dog runs on it", () => {
    const signedOut = claude({ state: "available", authenticated: false });
    expect(signedInModelInstances([signedOut], "claude")).toEqual([signedOut]);
    expect(signedInModelInstances([signedOut])).toEqual([]);
    expect(signedInModelInstances([signedOut], "codex")).toEqual([]);
  });

  it("keeps a Claude whose CLI is not found only while the dog runs on it", () => {
    const missing = claude({ state: "unavailable", reason: "`claude` CLI not found" });
    expect(signedInModelInstances([missing], "claude")).toEqual([missing]);
    expect(signedInModelInstances([missing])).toEqual([]);
    expect(signedInModelInstances([missing], "codex")).toEqual([]);
  });
});
