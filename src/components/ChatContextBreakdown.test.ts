// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { chatContextReading } from "@/lib/chat-context";
import { forgetBreakdowns } from "@/lib/context-breakdown";
import { api } from "@/state/store";
import type { ContextBreakdown } from "../../shared/context-breakdown";
import { ChatUsageButton } from "./ChatUsageButton";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

const NOW = 1_800_000_000_000;

const COUNTED: ContextBreakdown = {
  at: NOW - 5_000,
  source: "engine",
  total: 198_100,
  window: 1_000_000,
  compactsAt: 967_000,
  parts: [
    { id: "conversation", tokens: 128_800 },
    { id: "tools", tokens: 37_200 },
    { id: "instructions", tokens: 12_500 },
    { id: "skills", tokens: 10_000 },
    { id: "memory", tokens: 6_600 },
    { id: "helpers", tokens: 2_000 },
    { id: "other", tokens: 1_000 },
    { id: "reserve", tokens: 33_000 },
    { id: "free", tokens: 768_900 },
    { id: "tools", tokens: 451_500, deferred: true },
  ],
};

const ESTIMATED: ContextBreakdown = {
  at: NOW - 3 * 60_000,
  source: "estimate",
  total: 40_000,
  window: 200_000,
  parts: [
    { id: "conversation", tokens: 24_400 },
    { id: "tools", tokens: 10_000 },
    { id: "instructions", tokens: 2_600 },
    { id: "memory", tokens: 2_000 },
    { id: "skills", tokens: 1_000 },
    { id: "free", tokens: 160_000 },
  ],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset();
  forgetBreakdowns();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function openPanel(reading: ReturnType<typeof chatContextReading>, threadId: string | undefined = "thread-1") {
  act(() => root.render(createElement(ChatUsageButton, {
    mark: "M", title: "Usage", reading, threadId, accountName: null, provider: undefined, resting: undefined, now: NOW, onOpen: () => {}, onSeeAll: () => {},
  })));
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-chat-usage]")!.click(); });
  await act(async () => { for (let tick = 0; tick < 6; tick += 1) await Promise.resolve(); });
}

const panel = () => host.querySelector("[data-chat-usage-panel]")!;
const partLines = () => [...host.querySelectorAll("[data-chat-context-part]")].map((line) => [...line.querySelectorAll("span")].map((cell) => cell.textContent));
const toggle = () => host.querySelector<HTMLButtonElement>("[data-chat-context-toggle]")!;

describe("the context window row in a chat's usage", () => {
  it("asks the home when the panel opens and shows the engine's count, collapsed, above everything else", async () => {
    vi.mocked(api).mockResolvedValue(COUNTED);
    await openPanel(chatContextReading({ tokens: 198_100, window: 1_000_000 }));
    expect(api).toHaveBeenCalledWith("/api/threads/thread-1/context", expect.objectContaining({ timeoutMs: expect.any(Number) }));
    const row = panel().querySelector("[data-chat-context-source='engine']")!;
    expect(panel().firstElementChild).toBe(row);
    expect(toggle().textContent).toBe("This chat198k of 1M · 20%");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-chat-context-parts]")).toBeNull();
    expect([...host.querySelectorAll("[data-chat-context-segment]")].map((segment) => segment.getAttribute("data-chat-context-segment")))
      .toEqual(["conversation", "tools", "instructions", "skills", "memory", "other", "reserve"]);
    expect(row.textContent).not.toContain("about");
  });

  it("lists the parts largest first when opened, folding the small ones and keeping tools not loaded apart", async () => {
    vi.mocked(api).mockResolvedValue(COUNTED);
    await openPanel(chatContextReading({ tokens: 198_100, window: 1_000_000 }));
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(partLines()).toEqual([
      ["Conversation", "129k", "12.9%"],
      ["Tools", "37.2k", "3.7%"],
      ["Instructions", "12.5k", "1.3%"],
      ["Tricks", "10k", "1.0%"],
      ["Memory", "6.6k", "0.7%"],
      ["Everything else", "3k", "0.3%"],
      ["Kept free to tidy up", "33k", "3.3%"],
      ["Free", "769k", "76.9%"],
      ["Tools not loaded yet", "452k", "—"],
    ]);
    expect(host.querySelector("[data-chat-context-as-of]")).toBeNull();
  });

  it("says about before the total and every part when the numbers are the home's estimate, and how old they are", async () => {
    vi.mocked(api).mockResolvedValue(ESTIMATED);
    await openPanel(chatContextReading({ tokens: 40_000, window: 200_000 }));
    expect(toggle().textContent).toBe("This chatabout 40k of 200k · 20%");
    act(() => toggle().click());
    expect(partLines()[0]).toEqual(["Conversation", "about 24.4k", "12.2%"]);
    expect(partLines().every((line) => line[1]!.startsWith("about "))).toBe(true);
    expect(host.querySelector("[data-chat-context-as-of]")!.textContent).toBe("as of 3 min ago");
    expect(partLines().some((line) => line[0] === "Tools not loaded yet")).toBe(false);
  });

  it("says the row comes after the first reply when the chat has nothing yet", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("nothing yet", 404, { error: "nothing yet" }));
    await openPanel(null);
    const row = panel().querySelector("[data-chat-context='nothing']")!;
    expect(row.textContent).toBe("This chatShown after the first reply");
    expect(panel().textContent).not.toMatch(/\b0%|\b0 tokens/);
  });

  it("keeps today's single number when the home is older and has no such view", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("not found", 404, { error: "not found" }));
    await openPanel(chatContextReading({ tokens: 30_000, window: 200_000 }));
    const strip = panel().querySelector("[data-chat-context='15']")!;
    expect(strip.textContent).toBe("This chat30k of 200k · 15%");
    expect(host.querySelector("[data-chat-context-toggle]")).toBeNull();
    expect(host.querySelector("[data-chat-context-source]")).toBeNull();
  });

  it("shows nothing new when the home is older and the chat has no number either", async () => {
    vi.mocked(api).mockRejectedValue(new ApiError("not found", 404, { error: "not found" }));
    await openPanel(null);
    expect(host.querySelector("[data-chat-context]")).toBeNull();
  });

  it("shows the total alone when the estimate has no parts to show", async () => {
    vi.mocked(api).mockResolvedValue({ ...ESTIMATED, parts: [] });
    await openPanel(null);
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBeNull();
    expect(host.querySelectorAll("[data-chat-context-segment]")).toHaveLength(0);
  });

  it("shows the last answer at once when opened again, before the home answers", async () => {
    vi.mocked(api).mockResolvedValueOnce(COUNTED).mockReturnValueOnce(new Promise(() => {}));
    await openPanel(null);
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-chat-usage]")!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-chat-usage]")!.click(); });
    expect(panel().querySelector("[data-chat-context-source='engine']")).not.toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
