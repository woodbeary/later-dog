// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalVmRows, type LocalVmStatus } from "./LocalVmRows";

const vm = (patch: Partial<LocalVmStatus> = {}): LocalVmStatus => ({
  ready: true, container: "running", problem: null, resumable: false, stop_reason: null, viewer_url: "http://127.0.0.1:8006/", ...patch,
});
const stopped = (patch: Partial<LocalVmStatus> = {}) => vm({
  ready: false, container: "stopped", problem: "The Local VM is stopped; start it to continue", resumable: true, stop_reason: "idle", ...patch,
});
const booting = vm({ ready: false, problem: "The Local VM started, but Cua Driver is not ready yet" });

const fixture = {
  reads: [] as LocalVmStatus[],
  posts: [] as string[],
  answers: {} as Record<string, { status: number; body: unknown }>,
  confirm: true,
};

let root: Root | null = null;
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(LocalVmRows)));
  await flush();
};
const text = () => document.body.textContent ?? "";
const button = (name: string) => Array.from(document.querySelectorAll("button")).find((node) => node.textContent === name) ?? null;
const pill = () => document.querySelector("[data-local-vm-status]")!.textContent;
const press = async (name: string) => {
  flushSync(() => button(name)!.click());
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fixture.reads = [];
  fixture.posts = [];
  fixture.answers = {};
  fixture.confirm = true;
  vi.stubGlobal("confirm", () => fixture.confirm);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const action = url.split("/").pop()!;
      fixture.posts.push(action);
      const answer = fixture.answers[action] ?? { status: 200, body: booting };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    const next = fixture.reads.length > 1 ? fixture.reads.shift()! : fixture.reads[0];
    return new Response(JSON.stringify(next), { status: 200 });
  }));
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Settings → Computer → Local VM", () => {
  it("wakes a stopped VM with one start, waits for its desktop, and never rebuilds it", async () => {
    fixture.reads = [stopped(), booting, vm()];
    await mount();
    expect(text()).toContain("Stopped after inactivity to save resources.");
    expect(button("Reset")).not.toBeNull();

    await press("Start Local VM");
    expect(fixture.posts).toEqual(["start"]);
    expect(pill()).toBe("Waiting for the desktop…");
    const starting = button("Starting Local VM…")!;
    expect(starting.disabled).toBe(true);
    expect(starting.getAttribute("aria-busy")).toBe("true");
    expect(button("Reset")!.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(pill()).toBe("Waiting for the desktop…");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(pill()).toBe("Ready");
    expect(button("Start Local VM")).toBeNull();
    expect(button("Starting Local VM…")).toBeNull();
    expect(document.querySelector("a")!.textContent).toBe("Open");
    expect(fixture.posts).toEqual(["start"]);
  });

  it("explains a stop it didn't make itself", async () => {
    fixture.reads = [stopped({ stop_reason: null })];
    await mount();
    expect(text()).toContain("Your files and installed apps are still here. Start the VM to continue.");
    expect(text()).not.toContain("Stopped after inactivity");
  });

  it("offers only Reset for a stopped VM that a rebuild has to fix", async () => {
    fixture.reads = [stopped({ resumable: false, problem: "The existing Local VM uses an older desktop or Cua Driver; recreate it" })];
    await mount();
    expect(button("Start Local VM")).toBeNull();
    expect(text()).not.toContain("Your files and installed apps are still here.");
    expect(pill()).toBe("The existing Local VM uses an older desktop or Cua Driver; recreate it");
    expect(button("Reset")).not.toBeNull();
  });

  it("shows why a start failed and lets the person try again", async () => {
    fixture.reads = [stopped()];
    fixture.answers.start = { status: 409, body: { error: "another Local VM setup action is still running" } };
    await mount();
    await press("Start Local VM");
    expect(document.querySelector("[role=alert]")!.textContent).toBe("another Local VM setup action is still running");
    expect(button("Start Local VM")!.disabled).toBe(false);
  });

  it("rebuilds only after the person confirms Reset", async () => {
    fixture.reads = [vm()];
    fixture.confirm = false;
    await mount();
    await press("Reset");
    expect(fixture.posts).toEqual([]);

    fixture.confirm = true;
    fixture.answers.run = { status: 200, body: vm() };
    await press("Reset");
    expect(fixture.posts).toEqual(["remove", "run"]);
    expect(pill()).toBe("Ready");
  });

  it("creates a missing VM without asking", async () => {
    fixture.reads = [vm({ ready: false, container: "missing", problem: "Create the Local VM" }), vm()];
    fixture.confirm = false;
    fixture.answers.run = { status: 200, body: vm() };
    await mount();
    expect(button("Start Local VM")).toBeNull();
    await press("Create");
    expect(fixture.posts).toEqual(["run"]);
    expect(pill()).toBe("Ready");
  });
});
