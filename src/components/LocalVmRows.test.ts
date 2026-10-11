// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKER_URL, LocalVmRows, type LocalVmStatus } from "./LocalVmRows";

const vm = (patch: Partial<LocalVmStatus> = {}): LocalVmStatus => ({
  ready: true, runtime: "docker", daemonUp: true, image: true, container: "running", problem: null,
  resumable: false, stop_reason: null, viewer_url: "http://127.0.0.1:8006/", ...patch,
});
const stopped = (patch: Partial<LocalVmStatus> = {}) => vm({
  ready: false, container: "stopped", problem: "The Local VM is stopped; start it to continue", resumable: true, stop_reason: "idle", ...patch,
});
const missing = (patch: Partial<LocalVmStatus> = {}) => vm({ ready: false, container: "missing", problem: "Create the Local VM", ...patch });
const booting = vm({ ready: false, problem: "The Local VM started, but Cua Driver is not ready yet" });
const jargon = /container runtime|Cua|pinned|durable|image|Actions|Status/;

const fixture = {
  reads: [] as LocalVmStatus[],
  posts: [] as string[],
  answers: {} as Record<string, { status: number; body: unknown }>,
  confirm: true,
  asked: [] as string[],
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
const link = (name: string) => Array.from(document.querySelectorAll("a")).find((node) => node.textContent === name) ?? null;
const status = () => document.querySelector<HTMLElement>("[data-local-vm-status]")!;
const title = () => status().querySelector("[id]")!.textContent;
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
  fixture.asked = [];
  vi.stubGlobal("confirm", (message: string) => { fixture.asked.push(message); return fixture.confirm; });
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
  it("says it needs Docker and links to it when nothing can run the VM", async () => {
    fixture.reads = [missing({ runtime: null, daemonUp: false, image: false, problem: "Install a supported container runtime first" })];
    await mount();
    expect(title()).toBe("Needs Docker");
    expect(link("Get Docker")!.getAttribute("href")).toBe(DOCKER_URL);
    expect(button("Set up")).toBeNull();
    expect(button("Reset")).toBeNull();
    expect(text()).not.toMatch(jargon);
  });

  it("asks for Docker to be opened when it's installed but closed", async () => {
    fixture.reads = [missing({ daemonUp: false, image: false, problem: "Start docker first" })];
    await mount();
    expect(title()).toBe("Docker isn't running");
    expect(text()).toContain("Open Docker. This page updates by itself.");
    expect(document.querySelectorAll("button, a")).toHaveLength(0);
    fixture.reads = [missing({ runtime: "podman", daemonUp: false })];
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(title()).toBe("Podman isn't running");
  });

  it("sets up a new VM without asking, fetching the desktop first", async () => {
    fixture.reads = [missing({ image: false, problem: "Prepare the Cua desktop image with Driver 1" }), vm()];
    fixture.confirm = false;
    fixture.answers.run = { status: 200, body: vm() };
    await mount();
    expect(title()).toBe("Not set up");
    expect(text()).not.toMatch(jargon);
    await press("Set up");
    expect(fixture.posts).toEqual(["pull", "run"]);
    expect(fixture.asked).toEqual([]);
    expect(title()).toBe("Ready");
    expect(link("Open")!.getAttribute("href")).toBe("http://127.0.0.1:8006/");
  });

  it("skips the fetch when the desktop is already here", async () => {
    fixture.reads = [missing(), vm()];
    fixture.answers.run = { status: 200, body: vm() };
    await mount();
    await press("Set up");
    expect(fixture.posts).toEqual(["run"]);
  });

  it("wakes a stopped VM with one start, waits for its desktop, and never rebuilds it", async () => {
    fixture.reads = [stopped(), booting, vm()];
    await mount();
    expect(title()).toBe("Stopped");
    expect(text()).toContain("It stops when no dog is using it. Your files and installed apps are still here.");
    expect(button("Reset")).not.toBeNull();

    await press("Start");
    expect(fixture.posts).toEqual(["start"]);
    expect(title()).toBe("Starting…");
    expect(text()).toContain("This can take a minute.");
    expect(button("Start")).toBeNull();
    expect(button("Reset")).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(title()).toBe("Starting…");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(title()).toBe("Ready");
    expect(link("Open")).not.toBeNull();
    expect(fixture.posts).toEqual(["start"]);
  });

  it("explains a stop it didn't make itself", async () => {
    fixture.reads = [stopped({ stop_reason: null })];
    await mount();
    expect(text()).toContain("Your files and installed apps are still here.");
    expect(text()).not.toContain("no dog is using it");
  });

  it("offers only Reset for a VM that a rebuild has to fix", async () => {
    fixture.reads = [stopped({ resumable: false, problem: "The existing Local VM uses an older desktop or Cua Driver; recreate it" })];
    await mount();
    expect(title()).toBe("Needs a reset");
    expect(button("Start")).toBeNull();
    expect(button("Reset")).not.toBeNull();
    expect(text()).not.toMatch(jargon);
  });

  it("shows why a start failed and lets the person try again", async () => {
    fixture.reads = [stopped()];
    fixture.answers.start = { status: 409, body: { error: "another Local VM setup action is still running" } };
    await mount();
    await press("Start");
    expect(document.querySelector("[role=alert]")!.textContent).toBe("another Local VM setup action is still running");
    expect(button("Start")!.disabled).toBe(false);
  });

  it("rebuilds only after the person confirms Reset, fetching a newer desktop first", async () => {
    fixture.reads = [vm()];
    fixture.confirm = false;
    await mount();
    expect(text()).toContain("Start fresh if it gets stuck.");
    await press("Reset");
    expect(fixture.posts).toEqual([]);
    expect(fixture.asked[0]).not.toMatch(jargon);

    fixture.confirm = true;
    fixture.answers.run = { status: 200, body: vm() };
    await press("Reset");
    expect(fixture.posts).toEqual(["remove", "run"]);
    expect(title()).toBe("Ready");

    fixture.posts = [];
    fixture.reads = [vm({ image: false })];
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await press("Reset");
    expect(fixture.posts).toEqual(["pull", "remove", "run"]);
  });
});
