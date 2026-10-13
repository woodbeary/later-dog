// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  bots: [] as Bot[],
  instances: [] as InstanceInfo[],
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.bots, instances: fixture.instances }, dispatch: fixture.dispatch }),
}));

const { ExecutionRows, ThisComputerRow, computerName, executionChoices } = await import("./ComputerSettings");

const instance = (instanceId: string, driverKind: string) => ({ instanceId, driverKind, displayName: instanceId }) as unknown as InstanceInfo;
const dog = (id: string, patch: Partial<Bot> = {}) => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), color: "amber", modelSelection: { instanceId: "codex" }, approvalMode: "ask", ...patch,
}) as unknown as Bot;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.bots = [];
  fixture.instances = [instance("codex", "codex"), instance("claude", "claudeAgent"), instance("ag", "antigravityAgent")];
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const select = (botId: string) => document.querySelector<HTMLSelectElement>(`[data-execution-dog="${botId}"] select`)!;
const choose = (botId: string, mode: string) => act(async () => {
  const element = select(botId);
  element.value = mode;
  element.dispatchEvent(new Event("change", { bubbles: true }));
});
const warning = () => document.querySelector<HTMLElement>('[aria-labelledby="local-auto-warning-title"]');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;
const labels = (choices: ReturnType<typeof executionChoices>) => choices.options.map((option) => option.label);

describe("the computer's name", () => {
  it("is the host's name without the .local a Mac adds, and nothing when there is none", () => {
    expect(computerName("Jacobs-MacBook-Pro.local")).toBe("Jacobs-MacBook-Pro");
    expect(computerName("  studio  ")).toBe("studio");
    expect(computerName("my.local.box")).toBe("my.local.box");
    expect(computerName(".local")).toBeNull();
    expect(computerName("   ")).toBeNull();
    expect(computerName(42)).toBeNull();
    expect(computerName(undefined)).toBeNull();
  });

  it("reads it from the server and says This computer until then, or when it can't", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(createElement(ThisComputerRow)));
    expect(host.textContent).toBe("This computer");
    expect(fetch).toHaveBeenCalledWith("/.well-known/laterdog/environment", expect.anything());
    await act(async () => answer(new Response(JSON.stringify({ label: "Jacobs-MacBook-Pro.local" }), { status: 200 })));
    await settle();
    expect(host.textContent).toBe("Jacobs-MacBook-Pro");

    await act(async () => root.unmount());
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await act(async () => root.render(createElement(ThisComputerRow)));
    await settle();
    expect(host.textContent).toBe("This computer");
  });
});

describe("what each dog may pick", () => {
  it("is Heel or Off-leash, the same two as its profile", () => {
    const choices = executionChoices(dog("rio"), "codex");
    expect(choices.current).toBe("ask");
    expect(choices.options.map((option) => option.mode)).toEqual(["ask", "auto"]);
    expect(labels(choices)).toEqual(["Heel", "Off-leash"]);
  });

  it("keeps a level the dog already has, so it still reads true", () => {
    expect(labels(executionChoices(dog("rio", { approvalMode: "full" }), "claudeAgent"))).toEqual(["Heel", "Off-leash", "Full access"]);
    expect(labels(executionChoices(dog("rio", { approvalMode: "custom" }), "codex"))).toEqual(["Heel", "Off-leash", "Custom (config.toml)"]);
    const orphaned = executionChoices(dog("rio", { approvalMode: "edits" }), undefined);
    expect(orphaned.current).toBe("edits");
    expect(labels(orphaned)).toEqual(["Heel", "Off-leash", "Auto-accept edits"]);
  });

  it("reads Antigravity's stored Off-leash as Heel, the way its profile does, with no Off-leash to pick", () => {
    const choices = executionChoices(dog("rio", { approvalMode: "auto" }), "antigravityAgent");
    expect(choices.current).toBe("ask");
    expect(choices.options.map((option) => option.mode)).toEqual(["ask"]);
  });
});

describe("Execution on this computer", () => {
  it("lists every dog you can see with its level, and says so when there are none", async () => {
    await act(async () => root.render(createElement(ExecutionRows)));
    expect(host.textContent).toContain("No dogs yet.");

    fixture.bots = [dog("rio"), dog("willow", { approvalMode: "auto" }), dog("ghost", { hidden: true })];
    await act(async () => root.render(createElement(ExecutionRows)));
    expect([...document.querySelectorAll("[data-execution-dog]")].map((row) => row.getAttribute("data-execution-dog"))).toEqual(["rio", "willow"]);
    expect(host.textContent).toContain("Heel checks with you first. Off-leash does the work and asks before risky steps.");
    expect(select("rio").getAttribute("aria-label")).toBe("Rio's approval level");
    expect(select("rio").value).toBe("ask");
    expect(select("willow").value).toBe("auto");
    expect(host.textContent).not.toContain("No dogs yet.");
  });

  it("changes a dog's level the same way its profile does", async () => {
    fixture.bots = [dog("rio", { computer: "cloud" }), dog("willow", { approvalMode: "auto", computer: "local" })];
    await act(async () => root.render(createElement(ExecutionRows)));
    await choose("rio", "auto");
    await choose("willow", "ask");
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "updateBot", botId: "rio", patch: { approvalMode: "auto" } }],
      [{ type: "updateBot", botId: "willow", patch: { approvalMode: "ask" } }],
    ]);
    expect(warning()).toBeNull();
  });

  it("warns before letting a dog that uses this computer off the leash, and changes nothing on Cancel", async () => {
    fixture.bots = [dog("rio", { computer: "local" })];
    await act(async () => root.render(createElement(ExecutionRows)));
    await choose("rio", "auto");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(warning()?.textContent).toContain("Use Off-leash on this computer?");
    await act(async () => button("Cancel").click());
    expect(warning()).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(select("rio").value).toBe("ask");

    await choose("rio", "auto");
    await act(async () => button("OK").click());
    expect(warning()).toBeNull();
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "updateBot", botId: "rio", patch: { approvalMode: "auto", acknowledgeLocalAuto: true } }]]);
  });

  it("holds a dog's level while it is working, and when it has only one to pick", async () => {
    fixture.bots = [dog("rio", { busy: true }), dog("ada", { modelSelection: { instanceId: "ag" } } as Partial<Bot>)];
    await act(async () => root.render(createElement(ExecutionRows)));
    expect(select("rio").disabled).toBe(true);
    expect(select("rio").title).toBe("Stop this dog's turn before changing its approval level");
    expect(select("ada").disabled).toBe(true);
    expect(select("ada").title).toBe("");
    await choose("rio", "auto");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
