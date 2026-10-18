// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import { setLocale } from "@/lib/i18n";
import { CloudQuietLine } from "./CloudQuietLine";

let host: HTMLDivElement;
let root: Root;
let pushMove: (state: CloudMoveState) => void;
let pushAccount: (state: CloudAccountState) => void;
const home = { id: "cloud", name: "My Cloud", origin: "https://h1-home.later.dog", kind: "cloud" as const };
const overview = (state: Partial<CloudMoveOverview> = {}): CloudMoveOverview =>
  ({ phase: "idle", local: null, cloud: null, fit: null, suggest: false, automatic: true, destination: home, blocked: null, ...state });

function makeMove(initial: CloudMoveOverview): CloudMoveBridge {
  return {
    state: vi.fn(async () => initial),
    start: vi.fn(async () => ({ phase: "preparing" }) as CloudMoveState),
    cancel: vi.fn(async () => ({ phase: "idle" }) as CloudMoveState),
    restorePrevious: vi.fn(),
    dismiss: vi.fn(async () => overview()),
    onState: vi.fn((callback) => { pushMove = callback; return () => {}; }),
  } as unknown as CloudMoveBridge;
}

async function show(laterdog: Record<string, unknown>) {
  (window as unknown as { laterdog?: unknown }).laterdog = laterdog;
  await act(async () => { root.render(createElement(CloudQuietLine)); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}
const line = () => host.querySelector("[data-cloud-quiet-line]");
const text = () => line()?.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
async function click(label: string) {
  await act(async () => { button(label)!.click(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { laterdog?: unknown }).laterdog;
});

describe("the quiet line about this Mac's dogs", () => {
  it("shows nothing while nothing is moving", async () => {
    await show({ cloudMove: makeMove(overview()) });
    expect(line()).toBeNull();
  });

  it("follows the move: a percentage, the restart, then done, which clears itself", async () => {
    vi.useFakeTimers();
    const move = makeMove(overview());
    await show({ cloudMove: move });
    await act(async () => pushMove({ phase: "uploading", action: "move", destination: home, progress: { bytesTransferred: 30, totalBytes: 100 } }));
    expect(text()).toBe("Moving your dogs here from this Mac… 30%");
    expect(button("Try again")).toBeUndefined();
    await act(async () => pushMove({ phase: "restarting", action: "move", destination: home }));
    expect(text()).toBe("Almost there. Your home restarts to open them.");
    await act(async () => pushMove({ phase: "done", action: "move", destination: home, moved: { bots: 3, rooms: 0, chats: 8 } }));
    expect(text()).toContain("Your dogs from this Mac are here now. This Mac keeps its copy.");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(move.dismiss).toHaveBeenCalledOnce();
  });

  it("says the dogs are still on this Mac and retries on a tap", async () => {
    const move = makeMove(overview());
    await show({ cloudMove: move });
    await act(async () => pushMove({ phase: "failed", action: "move", destination: home, error: { code: "network", message: "x" } }));
    expect(text()).toContain("Your dogs are still on this Mac. They couldn't move yet.");
    await click("Try again");
    expect(move.start).toHaveBeenCalledOnce();
  });

  it("says plainly when the home already had dogs, and leaves them alone", async () => {
    const move = makeMove(overview({ phase: "failed", error: { code: "not_empty", message: "x" } }));
    await show({ cloudMove: move });
    expect(text()).toContain("Your home already has dogs, so the dogs on this Mac stayed here.");
    expect(button("Try again")).toBeUndefined();
    await click("OK");
    expect(move.dismiss).toHaveBeenCalledOnce();
  });

  it("says the Claude and ChatGPT accounts came along with the dogs, and names one that stayed", async () => {
    vi.useFakeTimers();
    const move = makeMove(overview());
    await show({ cloudMove: move });
    await act(async () => pushMove({ phase: "done", action: "move", destination: home, accounts: { moved: { claude: 1, chatgpt: 1 }, stayed: [] } }));
    expect(text()).toBe("Your dogs from this Mac are here now. This Mac keeps its copy. Your Claude and ChatGPT accounts are here too.OK");
    await act(async () => pushMove({ phase: "idle", destination: home, accounts: { moved: { claude: 1, chatgpt: 0 }, stayed: ["Work Claude"] } }));
    expect(text()).toBe("Your Claude account is here too. Work Claude stayed on this Mac for now.OK");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(move.dismiss).toHaveBeenCalled();
  });

  it("stays out of the way of a move the person started themselves", async () => {
    await show({ cloudMove: makeMove(overview({ automatic: undefined })) });
    await act(async () => pushMove({ phase: "uploading", action: "move", destination: home, progress: { bytesTransferred: 30, totalBytes: 100 } }));
    expect(line()).toBeNull();
  });

  it("on this Mac, says the home could not be reached and tries it again on a tap", async () => {
    const connectHome = vi.fn(async () => ({ status: "connected" }) as CloudAccountState);
    const cloudAccount = {
      state: vi.fn(async () => ({ status: "connected", fellBack: true }) as CloudAccountState),
      onState: vi.fn((callback) => { pushAccount = callback; return () => {}; }), connectHome,
    };
    await show({ localPage: true, cloudAccount, cloudMove: makeMove(overview({ automatic: undefined })) });
    expect(text()).toBe("Can't reach your home right now. Showing the dogs on this Mac.Try again");
    await click("Try again");
    expect(connectHome).toHaveBeenCalledOnce();
    await act(async () => pushAccount({ status: "connected" } as CloudAccountState));
    expect(line()).toBeNull();
  });
});
