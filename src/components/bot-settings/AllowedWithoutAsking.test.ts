import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { AlwaysAllowedList } from "../../../shared/lasting-allows";

const fixture = vi.hoisted(() => ({ list: null as unknown, index: 0 }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    return [index === 0 ? fixture.list : initial, () => {}];
  },
  useEffect: () => {},
}));
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), api: vi.fn() }));

import { AllowedWithoutAsking } from "./AllowedWithoutAsking";

const bot = { id: "bot-1", name: "Wren", alwaysAllow: [] } as unknown as Bot;
function render(list: AlwaysAllowedList | null): string {
  fixture.list = list;
  fixture.index = 0;
  return renderToStaticMarkup(AllowedWithoutAsking({ bot })!);
}

beforeEach(() => { fixture.index = 0; });

describe("Always allowed in a dog's settings", () => {
  it("lists a search grant and an old grant that stopped", () => {
    const html = render({ paused: false, items: [
      { id: "search:1", kind: "search", grantedAt: "2026-11-15T10:00:00.000Z", state: "active" },
      { id: "key:abc", kind: "outside-delete", state: "no-longer-used" },
    ] });
    expect(html).toContain("Always allowed");
    expect(html).toContain("Search");
    expect(html).toContain("Delete files outside its own folders");
    expect(html).toContain("No longer used");
    expect(html.match(/>Remove</g)).toHaveLength(2);
  });

  it("says how a grant gets there when there is none", () => {
    expect(render({ paused: false, items: [] })).toContain("Nothing yet. Tap Always allow on a card and it shows here.");
  });

  it("shows Paused with Resume after the emergency stop", () => {
    const html = render({ paused: true, items: [] });
    expect(html).toContain("Paused");
    expect(html).toContain("Resume");
  });

  it("names each kind of grant in the person's words", () => {
    const html = render({ paused: false, items: [
      { id: "search:1", kind: "search", state: "active" },
      { id: "key:a", kind: "app", subject: "gmail", state: "active" },
      { id: "key:b", kind: "outside-delete", state: "no-longer-used" },
      { id: "key:c", kind: "saved-login", subject: "example.com", state: "active" },
      { id: "key:d", kind: "teammate", subject: "Kiwi", state: "active" },
      { id: "command:e", kind: "command", subject: "pnpm test", state: "active" },
    ] });
    for (const words of ["Search for the same words", "Use Gmail", "Delete files outside its own folders",
      "Sign in to example.com with your saved login", "Start work with Kiwi", "Run pnpm test"]) expect(html).toContain(words);
  });

  it("dates an active grant in the person's own time zone and marks a stopped one", () => {
    const grantedAt = "2026-11-15T12:00:00.000Z";
    const day = new Date(grantedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
    const html = render({ paused: false, items: [
      { id: "search:1", kind: "search", grantedAt, state: "active" },
      { id: "key:b", kind: "outside-delete", state: "no-longer-used" },
      { id: "key:c", kind: "saved-login", subject: "example.com", state: "active" },
    ] });
    expect(html).toContain(`Allowed ${day}`);
    expect(html.match(/Allowed /g)).toHaveLength(1);
    expect(html).toContain("No longer used");
  });

  it("explains what Remove does only while at least one row is active and the list is not paused", () => {
    const hint = "Wren does these without asking you first.";
    const active = { id: "search:1", kind: "search", state: "active" } as const;
    const stopped = { id: "key:b", kind: "outside-delete", state: "no-longer-used" } as const;
    expect(render({ paused: false, items: [active, stopped] })).toContain(hint);
    expect(render({ paused: false, items: [stopped] })).not.toContain(hint);
    expect(render({ paused: true, items: [active] })).not.toContain(hint);
    expect(render({ paused: false, items: [] })).not.toContain(hint);
  });

  it("says the list could not be read instead of saying nothing yet", () => {
    const html = render({ paused: false, unreadable: true, items: [] });
    expect(html).toContain("later.dog could not read this list. Everything asks until it can.");
    expect(html).not.toContain("Nothing yet.");
    expect(html).not.toContain("does these without asking you first");
  });

  it("shows nothing to someone who may not see the list", () => {
    fixture.list = null;
    fixture.index = 0;
    expect(AllowedWithoutAsking({ bot })).toBeNull();
  });
});
