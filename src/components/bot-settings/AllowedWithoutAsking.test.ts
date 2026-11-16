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

  it("shows nothing to someone who may not see the list", () => {
    fixture.list = null;
    fixture.index = 0;
    expect(AllowedWithoutAsking({ bot })).toBeNull();
  });
});
