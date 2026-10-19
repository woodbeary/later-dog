// @vitest-environment happy-dom
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstanceInfo } from "@/state/store";
import type { TrialStatus } from "./CloudTrial";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  instances: [] as unknown[],
  trial: null as unknown,
  dispatch: vi.fn(),
  refreshInstances: vi.fn(),
  signIn: vi.fn(),
  startTrial: vi.fn(),
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { instances: fixture.instances }, dispatch: fixture.dispatch, refreshInstances: fixture.refreshInstances }),
}));
vi.mock("@/lib/add-account-request", () => ({ requestAccountSignIn: fixture.signIn, requestAddAccount: vi.fn() }));
vi.mock("./CloudTrial", () => ({ useCloudTrial: () => ({ status: fixture.trial, busy: false, error: null, start: fixture.startTrial }) }));

const { aiChoices } = await import("./AiChoices");
const { NoEngines } = await import("./NoEngines");
const { CloudEngineSignIn } = await import("./CloudEngineSignIn");

const engine = (instanceId: string, driverKind: string, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: instanceId, access: "subscription",
  snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] }, authentication: { method: "device-code" },
  ...extra,
} as InstanceInfo);
const kimi = engine("laterdogAi", "laterdogAi", { snapshot: { state: "unavailable", authenticated: false, reason: "Start the free trial to use the free models." } });
const signedOut = [
  kimi,
  engine("claude", "claudeAgent", { authentication: { method: "paste-code" } }),
  engine("claude-local", "claudeAgent", { access: "custom" }),
  engine("claudeApi", "claudeAgent", { access: "api" }),
  engine("codex", "codex"),
  engine("chatgpt", "codex", { authentication: { method: "browser-pkce" } }),
  engine("grok", "grokAgent"),
  engine("cursor", "cursorAgent"),
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  fixture.instances = signedOut;
  fixture.trial = { state: "offered", minutes: 60, days: 7, ai: true } satisfies TrialStatus;
  fixture.signIn.mockReset();
  fixture.startTrial.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function show(component: FunctionComponent) {
  await act(async () => root.render(createElement(component)));
  return [...host.querySelectorAll<HTMLElement>("[data-ai-choice]")];
}

it("shows one list on the Mac and on a Cloud home: the free AI, then Claude, ChatGPT, Grok and Cursor", async () => {
  for (const page of [NoEngines, CloudEngineSignIn]) {
    const rows = await show(page);
    expect(rows.map((row) => row.dataset.aiChoice)).toEqual(["free-ai", "claudeAgent", "codex", "grokAgent", "cursorAgent"]);
    expect(rows.map((row) => row.querySelector("button")?.textContent)).toEqual(["Try free", "Sign in", "Sign in", "Sign in", "Sign in"]);
    expect(host.textContent).not.toMatch(/API key card|Use an Anthropic API key|Set up My Cloud/);
  }
  expect(host.querySelector("[data-cloud-sign-in] [role=note]")?.textContent).toContain("Your AI plan's limits apply");
});

it("signs in on the person's own default account through the one sign-in sheet", async () => {
  const rows = await show(NoEngines);
  for (const [kind, instanceId] of [["claudeAgent", "claude"], ["codex", "chatgpt"], ["grokAgent", "grok"], ["cursorAgent", "cursor"]] as const) {
    const button = rows.find((row) => row.dataset.aiChoice === kind)!.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe(`Sign in to ${{ claudeAgent: "Claude", codex: "ChatGPT", grokAgent: "Grok", cursorAgent: "Cursor" }[kind]}`);
    await act(async () => button.click());
    expect(fixture.signIn).toHaveBeenLastCalledWith(instanceId);
  }
  await act(async () => rows[0]!.querySelector("button")!.click());
  expect(fixture.startTrial).toHaveBeenCalledOnce();
});

it("says plainly when this computer cannot run an engine, and installs first where it can", () => {
  const missingGrok = engine("grok", "grokAgent", { snapshot: { state: "unavailable", reason: "`grok` CLI not found" } });
  const installableCursor = engine("cursor", "cursorAgent", { snapshot: { state: "unavailable" }, install: { server: { package: "cursor-agent" } } });
  const choices = aiChoices([...signedOut.filter((instance) => !["grok", "cursor"].includes(instance.instanceId)), missingGrok, installableCursor]);
  expect(choices.find((choice) => choice.kind === "grokAgent")).toEqual({ kind: "grokAgent", name: "Grok", status: "unavailable" });
  expect(choices.find((choice) => choice.kind === "cursorAgent")).toEqual({ kind: "cursorAgent", name: "Cursor", status: "signIn", instanceId: "cursor" });
  expect(aiChoices([kimi]).map((choice) => choice.status)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
});

it("never offers a local-model, read-only, Company or policy-blocked engine as the person's account", () => {
  const blocked = [
    engine("claude-local", "claudeAgent", { access: "custom" }),
    engine("company.claude", "claudeAgent", { readOnly: true, managed: { organizationId: "o", organizationName: "Org" } }),
    engine("claude", "claudeAgent", { policy: { organizationName: "Org", reason: "Not allowed" } }),
  ];
  expect(aiChoices(blocked)[0]).toEqual({ kind: "claudeAgent", name: "Claude", status: "unavailable" });
  expect(aiChoices([engine("claude-work", "claudeAgent", { snapshot: { state: "available", authenticated: true } })])[0]?.status).toBe("ready");
});

it("leaves the free AI out where there is none, and says why it is off where it cannot start", async () => {
  fixture.instances = signedOut.filter((instance) => instance !== kimi);
  expect((await show(NoEngines)).map((row) => row.dataset.aiChoice)).not.toContain("free-ai");
  fixture.instances = signedOut;
  fixture.trial = { state: "none" } satisfies TrialStatus;
  const free = (await show(NoEngines))[0]!;
  expect(free.textContent).toContain("Start the free trial to use the free models.");
  expect(free.querySelector("button")).toBeNull();
});
