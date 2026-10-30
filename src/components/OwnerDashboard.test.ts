// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantSpend, OwnerReport } from "../../shared/included-usage";

const fixture = vi.hoisted(() => ({
  report: null as OwnerReport | null,
  saved: [] as GrantSpend[],
  failing: false,
  api: vi.fn(),
}));

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: fixture.api }));

const { setLocale } = await import("@/lib/i18n");
const { OwnerDashboard, grantDrafts, grantsFromDrafts, installName, spendSeries, usageMeasures } = await import("./OwnerDashboard");

const report = (patch: Partial<OwnerReport> = {}): OwnerReport => ({
  today: "2026-10-30",
  days: ["2026-10-28", "2026-10-29", "2026-10-30"],
  usage: [
    { day: "2026-10-29", kind: "transcribe_seconds", used: 5_400 },
    { day: "2026-10-30", kind: "transcribe_seconds", used: 28 },
    { day: "2026-10-30", kind: "ai_tokens", used: 475_961 },
    { day: "2026-10-30", kind: "grok_tokens", used: 187_580 },
    { day: "2026-10-29", kind: "voice_chars", used: 1_200 },
  ],
  active: [{ day: "2026-10-29", installs: 1 }, { day: "2026-10-30", installs: 2 }],
  activeInstalls: 2,
  spend: [
    { day: "2026-10-30", service: "chat", provider: "cloudflare", units: 58_117, micros: 56_318 },
    { day: "2026-10-30", service: "chat", provider: "xai", units: 1_478, micros: 296 },
    { day: "2026-10-29", service: "voice", provider: "elevenlabs", units: 1_200, micros: 360_000 },
  ],
  top: [
    { label: "ended", tier: "owner", owner: true, micros: 360_000, services: [{ service: "voice", units: 1_200, micros: 360_000 }] },
    { label: "trl_abcdefghijklmnop", tier: "home", owner: false, micros: 56_614, services: [{ service: "chat", units: 59_595, micros: 56_614 }] },
    { label: "ended", tier: null, owner: false, micros: 1_000, services: [] },
  ],
  grants: [],
  ...patch,
});

let host: HTMLDivElement;
let root: Root;
const section = (name: string) => host.querySelector<HTMLElement>(`[data-dashboard-${name}]`)!;
const texts = (scope: ParentNode, selector: string) => [...scope.querySelectorAll(selector)].map((each) => each.textContent);

async function settle() {
  await act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); });
}

async function show() {
  await act(async () => root.render(createElement(OwnerDashboard)));
  await settle();
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.report = report();
  fixture.saved = [];
  fixture.failing = false;
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (fixture.failing) throw new Error("offline");
    if (path === "/api/owner-usage/grants") {
      const asked = JSON.parse(String(init?.body)) as { grants: GrantSpend[] };
      fixture.saved = asked.grants.map((grant) => ({ ...grant, spentMicros: 416_614 }));
      return { grants: fixture.saved };
    }
    if (path.startsWith("/api/owner-usage")) return { report: fixture.report };
    throw new Error(`unexpected ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the owner dashboard", () => {
  it("shows the last 30 days of use as tiles with today's share, and charts the one you pick", async () => {
    await show();
    expect(fixture.api).toHaveBeenCalledWith("/api/owner-usage?days=30");
    const use = section("use");
    const tiles = () => [...use.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Last 30 days"] > button')];
    expect(tiles().map((tile) => tile.textContent)).toEqual([
      "Dictation1h 30mToday 28s",
      "Voice1.2k charactersToday 0",
      "Chat664k tokensToday 664k",
      "Active users2Today 2",
    ]);
    expect(use.querySelector('[role="group"][aria-label="Dictation by day"]')).not.toBeNull();
    await act(async () => tiles()[3]!.click());
    await act(async () => use.querySelector<HTMLButtonElement>('button[aria-label="Table"]')!.click());
    expect(use.querySelector("caption")!.textContent).toBe("Active users by day");
    expect(texts(use, "tbody tr")).toEqual(["Today2", "Oct 291"]);
  });

  it("adds up the estimated spend, names each provider in a legend and splits it by day", async () => {
    await show();
    const spend = section("spend");
    expect(spend.textContent).toContain("$0.42Last 30 days · estimated from list prices");
    expect(texts(spend, "ul li")).toEqual(["ElevenLabs$0.36", "Cloudflare$0.06", "xAI<$0.001"]);
    await act(async () => spend.querySelector<HTMLButtonElement>('button[aria-label="Table"]')!.click());
    expect(texts(spend, "thead th")).toEqual(["Day", "ElevenLabs", "Cloudflare", "xAI", "Total"]);
    expect(texts(spend, "tbody tr")).toEqual(["Today$0$0.06<$0.001$0.06", "Oct 29$0.36$0$0$0.36"]);
  });

  it("ranks users by cost without showing who they are, with what each one used", async () => {
    await show();
    const top = section("top");
    expect(texts(top, "li")).toEqual([
      "You$0.36Voice1.2k characters$0.36",
      "User abcdefCloud home$0.06Chat59.6k tokens$0.06",
      "Removed installEnded$0.001",
    ]);
    expect(top.textContent).not.toContain("trl_");
  });

  it("sets a grant and shows what is spent against it", async () => {
    await show();
    const grants = section("grants");
    expect(texts(grants, ".setting-row")).toEqual([
      "ElevenLabsNo grant set",
      "CloudflareNo grant set",
      "xAINo grant set",
      "AnthropicNo grant set",
    ]);
    await act(async () => grants.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => {
      type(grants.querySelector<HTMLInputElement>('input[aria-label="Cloudflare grant in US dollars"]')!, "5000");
      type(grants.querySelector<HTMLInputElement>('input[aria-label="Cloudflare grant counted from"]')!, "2026-10-01");
    });
    await act(async () => grants.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(fixture.api).toHaveBeenCalledWith("/api/owner-usage/grants", expect.objectContaining({ method: "PUT" }));
    expect(fixture.saved).toEqual([{ provider: "cloudflare", usd: 5_000, since: "2026-10-01", spentMicros: 416_614 }]);
    expect(grants.querySelector("input")).toBeNull();
    expect(texts(grants, ".setting-row")[1]).toBe("Cloudflare$0.42 spent of $5,000 since Oct 1100% left");
    expect(grants.querySelector('[role="meter"]')!.getAttribute("aria-valuenow")).toBe("100");
  });

  it("refuses a grant it can't save and says so", async () => {
    await show();
    const grants = section("grants");
    await act(async () => grants.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => type(grants.querySelector<HTMLInputElement>('input[aria-label="xAI grant in US dollars"]')!, "-5"));
    await act(async () => grants.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(grants.querySelector('[role="alert"]')!.textContent).toBe("Couldn't save the grants. Check the amounts and dates.");
    expect(fixture.api).not.toHaveBeenCalledWith("/api/owner-usage/grants", expect.anything());
  });

  it("says when it can't load, and tries again on Refresh", async () => {
    fixture.failing = true;
    await show();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Couldn't load the dashboard.");
    fixture.failing = false;
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(section("use")).not.toBeNull();
  });
});

describe("dashboard figures", () => {
  it("counts active users once over the period, not once per day", () => {
    const active = usageMeasures(report()).find((each) => each.key === "active")!;
    expect(active).toMatchObject({ values: [0, 1, 2], total: 2, today: 2 });
  });

  it("keeps each provider's colour whatever else has spend", () => {
    expect(spendSeries(report()).map((each) => [each.key, each.color])).toEqual([["elevenlabs", 1], ["cloudflare", 2], ["xai", 3]]);
    expect(spendSeries(report({ spend: [{ day: "2026-10-30", service: "chat", provider: "xai", units: 1, micros: 5 }] })).map((each) => each.color)).toEqual([3]);
  });

  it("names installs by a short trial id only", () => {
    expect(installName({ label: "trl_abcdefghijklmnop", owner: false })).toBe("User abcdef");
    expect(installName({ label: "ended", owner: false })).toBe("Removed install");
    expect(installName({ label: "ended", owner: true })).toBe("You");
  });

  it("turns the grant form into grants, leaving blank amounts out", () => {
    const drafts = grantDrafts([{ provider: "xai", usd: 250, since: "2026-09-01" }], "2026-10-30");
    expect(drafts.xai).toEqual({ usd: "250", since: "2026-09-01" });
    expect(drafts.anthropic).toEqual({ usd: "", since: "2026-10-30" });
    expect(grantsFromDrafts({ ...drafts, cloudflare: { usd: " 1000 ", since: "2026-10-01" } })).toEqual([
      { provider: "cloudflare", usd: 1_000, since: "2026-10-01" },
      { provider: "xai", usd: 250, since: "2026-09-01" },
    ]);
  });
});
