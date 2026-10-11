// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

type Snapshot = Partial<InstanceInfo["snapshot"]>;

const fixture = vi.hoisted(() => ({
  instances: [] as InstanceInfo[],
  server: [] as InstanceInfo[],
  listeners: new Set<() => void>(),
  routes: {} as Record<string, (body: unknown) => unknown>,
  calls: [] as string[],
  open: vi.fn(async (_url: string) => {}),
  refreshModels: vi.fn(async (_instanceId: string) => {}),
}));

function publish(instances: InstanceInfo[]) {
  fixture.instances = instances;
  for (const listener of fixture.listeners) listener();
}

vi.mock("@/state/store", async () => {
  const { useSyncExternalStore } = await import("react");
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  const subscribe = (listener: () => void) => {
    fixture.listeners.add(listener);
    return () => {
      fixture.listeners.delete(listener);
    };
  };
  const dispatch = (action: { type: string; instances?: InstanceInfo[] }) => {
    if (action.type === "instances") publish(action.instances ?? []);
  };
  const api = async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    fixture.calls.push(key);
    const route = fixture.routes[key];
    if (!route) throw new ApiError(`no route for ${key}`, 404);
    return route(init?.body ? JSON.parse(String(init.body)) : undefined);
  };
  return {
    ApiError,
    api,
    useStore: () => ({
      state: { instances: useSyncExternalStore(subscribe, () => fixture.instances) },
      dispatch,
      refreshModels: fixture.refreshModels,
    }),
  };
});
vi.mock("@/lib/app-links", async (original) => ({ ...(await original<typeof import("@/lib/app-links")>()), openExternalLink: fixture.open }));

const { ApiError } = await import("@/state/store");
const { EnginesBeat } = await import("./EnginesBeat");

const engine = (instanceId: string, driverKind: string, patch: Partial<InstanceInfo> = {}, snapshot: Snapshot = {}): InstanceInfo => ({
  instanceId,
  driverKind,
  displayName: instanceId,
  snapshot: { state: "available", authenticated: false, ...snapshot },
  models: { default: "m", options: [] },
  install: { docsUrl: "https://example.test", server: { package: "fixture" } },
  ...patch,
});
const claude = (snapshot: Snapshot = {}, patch: Partial<InstanceInfo> = {}) =>
  engine("claude", "claudeAgent", { displayName: "Claude Code", authentication: { method: "paste-code", signOut: true }, ...patch }, snapshot);
const chatgpt = (snapshot: Snapshot = {}, patch: Partial<InstanceInfo> = {}) =>
  engine("chatgpt", "codex", { displayName: "ChatGPT plan", authentication: { method: "browser-pkce", signOut: true }, ...patch }, { chatgptPlan: true, ...snapshot });
const codex = (snapshot: Snapshot = {}) => engine("codex", "codex", { displayName: "Codex", authentication: { method: "device-code", signOut: true } }, snapshot);
const missing: Snapshot = { state: "unavailable", authenticated: undefined, reason: "`codex` CLI not found" };
const fleet = () => [
  engine("grok", "grokAgent", { displayName: "Grok" }, { state: "unavailable", reason: "`grok` CLI not found" }),
  engine("cursor", "cursorAgent", { displayName: "Cursor" }, { state: "unavailable", reason: "`cursor-agent` CLI not found" }),
  claude({ authenticated: true, version: "2.1.232 (Claude Code)" }),
  codex(missing),
  chatgpt(missing),
  engine("openaiCompat", "openai-compat", { displayName: "OpenAI-compatible", access: "custom" }, { state: "unavailable" }),
  engine("kimi", "kimiAgent", { displayName: "Kimi" }, { state: "unavailable" }),
];
const replace = (instance: InstanceInfo) => {
  fixture.server = fixture.server.map((item) => (item.instanceId === instance.instanceId ? instance : item));
  return fixture.server;
};
const chatgptWaiting = {
  phase: "waiting", flowId: "flow-chatgpt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture", expiresAt: "2030-01-01T00:15:00.000Z",
};
const claudeWaiting = {
  phase: "waiting", flowId: "flow-claude", authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true&state=fixture", expiresAt: "2030-01-01T00:15:00.000Z",
};

const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };
let host: HTMLDivElement;
let root: Root;

const settle = () => act(async () => {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
});
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5);
  });
  await settle();
};
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(EnginesBeat, props)));
  await settle();
}
const row = (id: string) => document.body.querySelector<HTMLElement>(`[data-onboarding-account="${id}"]`)!;
const rowIds = () => [...document.body.querySelectorAll<HTMLElement>("[data-onboarding-account]")].map((element) => element.dataset.onboardingAccount);
const buttonIn = (within: ParentNode) => within.querySelector<HTMLButtonElement>("button");
const continueButton = () => [...document.body.querySelectorAll("button")].find((element) => element.textContent === "Continue")!;
const notice = () => document.body.querySelector("[aria-live]")!.textContent;
const click = async (element: HTMLElement | null) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
  await settle();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = async (input: HTMLInputElement, key: string) => {
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  await settle();
};
const paste = async (input: HTMLInputElement, text: string) => {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  await act(async () => input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true })));
  await settle();
};
const everythingShown = () => [
  document.body.textContent ?? "",
  ...[...document.body.querySelectorAll("*")].flatMap((element) => ["title", "aria-label", "placeholder"].map((name) => element.getAttribute(name) ?? "")),
].join(" ");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setLocale("en");
  fixture.listeners.clear();
  fixture.instances = [];
  fixture.server = fleet();
  fixture.calls = [];
  fixture.routes = { "GET /api/instances": () => ({ instances: fixture.server }) };
  fixture.open.mockClear();
  fixture.refreshModels.mockClear();
  for (const callback of Object.values(props)) callback.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the AI step of first run", () => {
  it("shows Claude and ChatGPT, and no other engine", async () => {
    await mount();
    expect(rowIds()).toEqual(["claude", "chatgpt"]);
    expect(row("claude").textContent).toBe("ClaudeReady");
    expect(row("chatgpt").textContent).toBe("ChatGPTSign in");
    for (const other of ["Cursor", "OpenAI-compatible", "Grok", "Kimi", "Coming soon"]) expect(document.body.textContent).not.toContain(other);
  });

  it("never shows a version, a command-line word, a setup pill or a status colour", async () => {
    fixture.routes["POST /api/instances/chatgpt/install"] = () => new Promise(() => {});
    await mount();
    const check = () => {
      expect(everythingShown()).not.toMatch(/\d+\.\d+/);
      expect(everythingShown()).not.toMatch(/codex|\bCLI\b|server|terminal|needs setup|version/i);
      expect(document.body.innerHTML).not.toMatch(/(?:text|bg)-(?:success|warning)/);
    };
    check();
    await click(buttonIn(row("chatgpt")));
    expect(row("chatgpt").textContent).toBe("ChatGPTSigning in…");
    check();
  });

  it("says Ready quietly with a check, or offers a Sign in named for its row", async () => {
    await mount();
    expect(buttonIn(row("claude"))).toBeNull();
    expect(row("claude").querySelector("svg.lucide-check")).not.toBeNull();
    expect(buttonIn(row("chatgpt"))!.getAttribute("aria-label")).toBe("Sign in to ChatGPT");
  });

  it("reads ChatGPT as Ready when either of its sign-ins works", async () => {
    fixture.server = [claude(), codex({ authenticated: true }), chatgpt()];
    await mount();
    expect(row("claude").textContent).toBe("ClaudeSign in");
    expect(row("chatgpt").textContent).toBe("ChatGPTReady");
  });

  it("installs ChatGPT, signs in through the browser and reads Ready, all from one press", async () => {
    let phase = "waiting";
    fixture.routes["POST /api/instances/chatgpt/install"] = () => ({ instances: replace(chatgpt()) });
    fixture.routes["POST /api/instances/chatgpt/auth/start"] = () => ({ auth: chatgptWaiting });
    fixture.routes["GET /api/instances/chatgpt/auth/status"] = () => {
      if (phase === "succeeded") replace(chatgpt({ authenticated: true }));
      return { auth: { ...chatgptWaiting, phase } };
    };
    await mount();
    await click(buttonIn(row("chatgpt")));
    expect(fixture.calls).toEqual(["GET /api/instances", "POST /api/instances/chatgpt/install", "POST /api/instances/chatgpt/auth/start"]);
    expect(fixture.open).toHaveBeenCalledWith(chatgptWaiting.authorizationUrl);
    expect(row("chatgpt").textContent).toBe("ChatGPTSigning in…");

    await advance(2_000);
    expect(fixture.calls.at(-1)).toBe("GET /api/instances/chatgpt/auth/status");
    expect(row("chatgpt").textContent).toBe("ChatGPTSigning in…");

    phase = "succeeded";
    await advance(2_000);
    expect(row("chatgpt").textContent).toBe("ChatGPTReady");
    expect(fixture.refreshModels).toHaveBeenCalledWith("chatgpt");
    expect(notice()).toBe("");
  });

  it("reopens the sign-in page from the busy button, which keeps saying Signing in", async () => {
    fixture.server = [claude({ authenticated: true }), chatgpt()];
    fixture.routes["POST /api/instances/chatgpt/auth/start"] = () => ({ auth: chatgptWaiting });
    fixture.routes["GET /api/instances/chatgpt/auth/status"] = () => ({ auth: chatgptWaiting });
    await mount();
    await click(buttonIn(row("chatgpt")));
    expect(fixture.calls).not.toContain("POST /api/instances/chatgpt/install");
    const busy = buttonIn(row("chatgpt"))!;
    expect(busy.textContent).toBe("Signing in…");
    expect(busy.title).toBe("Open the sign-in page again");
    await click(busy);
    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(fixture.calls.filter((call) => call.endsWith("/auth/start"))).toHaveLength(1);
  });

  it("signs Claude in with one press and the code pasted from the browser, inside the same row", async () => {
    fixture.server = [claude(), chatgpt(missing)];
    const completes: unknown[] = [];
    fixture.routes["POST /api/instances/claude/auth/start"] = () => ({ auth: claudeWaiting });
    fixture.routes["POST /api/instances/claude/auth/complete"] = (body) => {
      completes.push(body);
      replace(claude({ authenticated: true }));
      return { ok: true, auth: { ...claudeWaiting, phase: "succeeded", authorizationUrl: null } };
    };
    await mount();
    expect(row("claude").textContent).toBe("ClaudeSign in");
    await click(buttonIn(row("claude")));
    expect(fixture.calls).toEqual(["GET /api/instances", "POST /api/instances/claude/auth/start"]);
    expect(fixture.open).toHaveBeenCalledWith(claudeWaiting.authorizationUrl);

    const input = row("claude").querySelector("input")!;
    expect(input.placeholder).toBe("Paste the code from your browser");
    expect(document.activeElement).toBe(input);
    expect(buttonIn(row("claude"))!.textContent).toBe("Signing in…");
    expect(row("claude").className).toContain("h-14");
    expect(rowIds()).toEqual(["claude", "chatgpt"]);

    await paste(input, "  abcdefgh#state ");
    expect(completes).toEqual([{ flowId: "flow-claude", code: "abcdefgh#state" }]);
    await advance(0);
    expect(row("claude").textContent).toBe("ClaudeReady");
    expect(fixture.refreshModels).toHaveBeenCalledWith("claude");
  });

  it("keeps the paste field when Claude refuses a code, and says so in one sentence", async () => {
    fixture.server = [claude(), chatgpt(missing)];
    fixture.routes["POST /api/instances/claude/auth/start"] = () => ({ auth: claudeWaiting });
    fixture.routes["POST /api/instances/claude/auth/complete"] = () => {
      throw new ApiError("Paste the whole code shown on Anthropic's page after signing in.", 400);
    };
    fixture.routes["GET /api/instances/claude/auth/status"] = () => ({ auth: claudeWaiting });
    await mount();
    await click(buttonIn(row("claude")));
    const input = row("claude").querySelector("input")!;
    await type(input, "not a code");
    await press(input, "Enter");
    expect(fixture.calls).toContain("POST /api/instances/claude/auth/complete");
    expect(notice()).toBe("That code didn't work. Copy it again from your browser.");
    expect(row("claude").querySelector("input")!.value).toBe("");
    expect(document.activeElement).toBe(row("claude").querySelector("input"));
    expect(document.body.textContent).not.toContain("Anthropic");
  });

  it("says one short sentence when setting up fails, and offers Sign in again", async () => {
    fixture.routes["POST /api/instances/chatgpt/install"] = () => {
      throw new ApiError("npm could not install @openai/codex on this server.\nnpm ERR! code ECONNRESET", 500);
    };
    await mount();
    await click(buttonIn(row("chatgpt")));
    expect(notice()).toBe("Couldn't set up ChatGPT. Try again.");
    expect(row("chatgpt").textContent).toBe("ChatGPTSign in");
    expect(fixture.calls).not.toContain("POST /api/instances/chatgpt/auth/start");
    expect(document.body.textContent).not.toMatch(/npm|ECONNRESET/);
  });

  it("says when a browser sign-in did not finish", async () => {
    fixture.server = [claude({ authenticated: true }), chatgpt()];
    fixture.routes["POST /api/instances/chatgpt/auth/start"] = () => ({ auth: chatgptWaiting });
    fixture.routes["GET /api/instances/chatgpt/auth/status"] = () => ({ auth: { ...chatgptWaiting, phase: "failed", message: "ChatGPT sign-in was not approved. You can try again in Settings." } });
    await mount();
    await click(buttonIn(row("chatgpt")));
    await advance(2_000);
    expect(notice()).toBe("Couldn't sign in to ChatGPT. Try again.");
    expect(row("chatgpt").textContent).toBe("ChatGPTSign in");
  });

  it("says Not available on this Mac, with no button, when this Mac cannot set an engine up", async () => {
    fixture.server = [claude({ authenticated: true }), chatgpt(missing, { install: { docsUrl: "https://example.test" } })];
    await mount();
    expect(row("chatgpt").textContent).toBe("ChatGPTNot available on this Mac");
    expect(buttonIn(row("chatgpt"))).toBeNull();
  });

  it("draws both rows at their final height before the status arrives, and nothing above Continue changes when it does", async () => {
    let answer!: (value: unknown) => void;
    fixture.routes["GET /api/instances"] = () => new Promise((resolve) => {
      answer = resolve;
    });
    await mount();
    const list = document.body.querySelector("ul")!;
    expect(list.getAttribute("aria-busy")).toBe("true");
    expect(rowIds()).toEqual(["claude", "chatgpt"]);
    for (const id of ["claude", "chatgpt"]) {
      expect(row(id).className).toContain("h-14");
      expect(buttonIn(row(id))).toBeNull();
      expect(row(id).querySelector(".animate-spin")).not.toBeNull();
    }
    expect(row("claude").textContent).toBe("Claude");
    const layout = () => [...continueButton().parentElement!.children].map((element) => `${element.tagName} ${element.className}`);
    const rowClasses = () => rowIds().map((id) => row(id!).className);
    const before = { layout: layout(), rows: rowClasses() };
    expect(notice()).toBe("");

    await act(async () => answer({ instances: fixture.server }));
    await settle();
    expect(list.getAttribute("aria-busy")).toBe("false");
    expect(row("claude").textContent).toBe("ClaudeReady");
    expect(row("chatgpt").textContent).toBe("ChatGPTSign in");
    expect({ layout: layout(), rows: rowClasses() }).toEqual(before);
  });

  it("says when it cannot check, and tries again by itself", async () => {
    fixture.routes["GET /api/instances"] = () => {
      throw new Error("offline");
    };
    await mount();
    expect(notice()).toBe("Couldn't check your sign-ins. Trying again…");
    fixture.routes["GET /api/instances"] = () => ({ instances: fixture.server });
    await advance(3_000);
    expect(notice()).toBe("");
    expect(row("claude").textContent).toBe("ClaudeReady");
  });

  it("has no refresh button, and follows the shared engine list the app re-reads when its window regains focus", async () => {
    fixture.server = [claude(), chatgpt(missing)];
    await mount();
    expect(document.body.querySelector('[aria-label="Check again"]')).toBeNull();
    expect([...document.body.querySelectorAll("button")].map((element) => element.textContent)).toEqual(["Sign in", "Sign in", "Continue"]);
    await act(async () => publish([claude({ authenticated: true }), chatgpt(missing)]));
    expect(row("claude").textContent).toBe("ClaudeReady");
  });

  it("looks proud once a plan is ready, curious while none is", async () => {
    await mount();
    expect(props.setMascot).toHaveBeenLastCalledWith("proud");
    expect(props.bump).toHaveBeenCalledWith("success");
    await act(async () => publish([claude(), chatgpt(missing)]));
    expect(props.setMascot).toHaveBeenLastCalledWith("curious");
  });
});
