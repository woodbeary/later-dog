import { describe, expect, it } from "vitest";

import {
  HIDDEN_SECTION_ID,
  UNASSIGNED_SECTION_ID,
  moveSection,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sidebarConnectorPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionNames,
  userSectionId,
  userSectionName,
} from "./sidebar-layout";

describe("sidebar virtual sections", () => {
  it("keeps reserved ids separate from identically named user sections", () => {
    for (const name of ["Pinned", "Hidden", "Unassigned", "bots", "hidden", "Bot Chats"]) {
      const id = userSectionId(name);
      expect([UNASSIGNED_SECTION_ID, HIDDEN_SECTION_ID]).not.toContain(id);
      expect(userSectionName(id)).toBe(name);
    }
    expect(userSectionName(UNASSIGNED_SECTION_ID)).toBeNull();
    expect(userSectionName(HIDDEN_SECTION_ID)).toBeNull();
  });

  it("round-trips every valid section name without URI encoding", () => {
    const maxLengthEmojiName = "🧠".repeat(30);
    expect(maxLengthEmojiName).toHaveLength(60);

    for (const name of ["Design / Research", "100%", "\ud800", maxLengthEmojiName]) {
      const id = userSectionId(name);
      expect(id).toBe(`section:${name}`);
      expect(userSectionName(id)).toBe(name);
    }
  });

  it("shows pinned bots once without erasing their saved context, and keeps hidden dogs apart", () => {
    const bot = { id: "writer", section: "Work", pinned: true };
    const hidden = { id: "hidden", hidden: true, pinned: true, section: "Work" };
    const parts = partitionSidebarBots([
      { id: "main", chiefOfStaff: true },
      bot,
      { id: "plain" },
      hidden,
    ]);
    expect(parts.pinnedBots).toEqual([bot]);
    expect(parts.sectionedBots).toEqual([]);
    expect(parts.unsectionedBots.map((candidate) => candidate.id)).toEqual(["main", "plain"]);
    expect(parts.hiddenBots).toEqual([hidden]);
    expect(bot.section).toBe("Work");
    expect(hidden.section).toBe("Work");
  });

  it("leaves dog-to-dog exchanges out of the sidebar without rewriting their comms context", () => {
    const dm = { id: "dm", dm: true, section: "Work" };
    const namedBotChats = { id: "named", section: "Bot Chats" };
    const parts = partitionSidebarGroups([
      dm,
      { id: "project", section: "Work" },
      namedBotChats,
      { id: "general" },
    ]);
    expect(parts.sectionedRooms.map((room) => room.id)).toEqual(["project", "named"]);
    expect(parts.unsectionedRooms.map((room) => room.id)).toEqual(["general"]);
    expect(dm.section).toBe("Work");
    expect(namedBotChats.section).toBe("Bot Chats");
  });

  it("keeps the main dog in its own section like any other dog", () => {
    const main = { id: "main", chiefOfStaff: true, section: "Work" };
    const parts = partitionSidebarBots([main, { id: "other", section: "Work" }]);
    expect(parts.sectionedBots.map((bot) => bot.id)).toEqual(["main", "other"]);
    expect(parts.pinnedBots).toEqual([]);
  });

  it("lifts pinned dogs from every section and shows the main dog first", () => {
    const home = { id: "home", section: "Home", pinned: true };
    const main = { id: "main", chiefOfStaff: true, section: "Work", pinned: true };
    const stay = { id: "stay", section: "Work" };
    const hidden = { id: "hidden", section: "Home", pinned: true, hidden: true };
    const parts = partitionSidebarBots([home, main, stay, hidden]);
    expect(parts.pinnedBots.map((bot) => bot.id)).toEqual(["main", "home"]);
    expect(parts.sectionedBots).toEqual([stay]);
    expect(main.section).toBe("Work");
    expect(home.section).toBe("Home");
  });

  it("lets only the full sidebar collapse or reorder sections", () => {
    expect(sidebarLayoutInteractive("comfortable")).toBe(true);
    expect(sidebarLayoutInteractive("icons")).toBe(false);
    expect(sidebarSectionCollapsed(HIDDEN_SECTION_ID, [HIDDEN_SECTION_ID], "comfortable")).toBe(true);
    expect(sidebarSectionCollapsed(HIDDEN_SECTION_ID, [], "comfortable")).toBe(false);
    expect(sidebarSectionCollapsed(HIDDEN_SECTION_ID, [HIDDEN_SECTION_ID], "icons")).toBe(false);
  });

  it("previews a connection card by its app and state, not the phone fallback line", () => {
    const say = (key: string) => ({
      "connectors.card.connected": "Connected",
      "connectors.card.waiting": "Waiting for sign-in…",
      "connectors.card.connectSecurely": "Connect securely",
    })[key] ?? key;
    const card = { label: "GitHub", status: "required" as const };
    expect(sidebarConnectorPreview(card, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "failed" }, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "authorizing" }, say)).toBe("GitHub · Waiting for sign-in…");
    expect(sidebarConnectorPreview({ ...card, status: "connected" }, say)).toBe("GitHub · Connected");
    expect(sidebarConnectorPreview({ ...card, dismissed: true }, say)).toBe("GitHub");
  });
});

describe("sidebar section ordering", () => {
  it("follows the server's saved order and adds sections only records name at the end", () => {
    expect(sidebarSectionNames(["Work", "Home"], [{ section: "Home" }, {}, { section: "Side" }, { section: "Side" }])).toEqual(["Work", "Home", "Side"]);
    expect(sidebarSectionNames([], [])).toEqual([]);
  });

  it("moves and drops sections without wrapping", () => {
    const names = ["Work", "Home", "Side"];
    expect(moveSection(names, "Home", -1)).toEqual(["Home", "Work", "Side"]);
    expect(moveSection(names, "Work", -1)).toBe(names);
    expect(moveSection(names, "Side", 1)).toBe(names);
    expect(placeSection(names, "Side", "Work", "before")).toEqual(["Side", "Work", "Home"]);
    expect(placeSection(names, "Work", "Side", "after")).toEqual(["Home", "Side", "Work"]);
    expect(placeSection(names, "Work", "Work", "after")).toBe(names);
  });
});
