import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { ConfirmDialogCard } from "./ConfirmDialog";
import { BotListItem, botDeleteCopy, botRowProps, roomDeleteCopy } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
}) as Bot;

const rowProps = (value: Bot) => botRowProps(initialState, () => {}, value, { density: "comfortable", onMenu: () => {} });

function renderRow(value: Bot): string {
  return renderToStaticMarkup(createElement(BotListItem, rowProps(value)));
}

afterEach(() => {
  setLocale("en");
});

describe("sidebar rows", () => {
  it("translates the row's own copy and its actions", () => {
    setLocale("pt-br");
    const markup = renderRow(bot({ chiefOfStaff: true, busy: true }));

    expect(markup).toContain("Trabalhando…");
    expect(markup).not.toContain("Chief of Staff");
    expect(markup).not.toContain("Chefe de gabinete");

    setLocale("ja");
    expect(renderRow(bot())).toContain(`aria-label="${t("sidebar.bot.actions", { name: "Atlas" })}"`);
  });
});

describe("delete confirmation copy", () => {
  it("translates and keeps the bot's name out of the catalog", () => {
    setLocale("pt-br");
    const remove = botDeleteCopy("Willow");
    expect(remove.body).toContain("Willow");
    expect(remove.confirmLabel).toBe("Excluir");
    setLocale("zh");
    expect(botDeleteCopy("Willow").title).toBe("删除 Willow？");
  });
});

describe("hide and read words", () => {
  it("translates Hide from sidebar, Show in sidebar and Mark as Read", () => {
    setLocale("pt-br");
    expect(t("sidebar.bot.hide")).toBe("Ocultar da barra lateral");
    expect(t("sidebar.bot.show")).toBe("Mostrar na barra lateral");
    setLocale("de");
    expect(t("sidebar.bot.markRead")).toBe("Als gelesen markieren");
    expect(t("sidebar.unreads.below", { count: 3 })).toBe("Zu 3 ungelesenen Chats unten springen");
  });
});

describe("room delete confirmation copy", () => {
  it("names the group chat and says what goes and what stays", () => {
    const copy = roomDeleteCopy({ name: "Launch plan" });
    expect(copy.title).toBe("Delete Launch plan?");
    expect(copy.body).toContain("Launch plan group chat");
    expect(copy.body).not.toMatch(/thread/);
    expect(copy.body).toMatch(/routines/);
    expect(copy.body).toMatch(/dogs in it are not deleted/);
    expect(copy.body).toMatch(/cannot be undone/);
    expect(copy.confirmLabel).toBe(t("sidebar.room.deleteChannel"));
    expect(copy.tone).toBe("danger");
  });

  it("renders as a danger alert dialog with Cancel before the delete action", () => {
    const markup = renderToStaticMarkup(createElement(ConfirmDialogCard, {
      open: true,
      ...roomDeleteCopy({ name: "Launch plan" }),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Delete Launch plan?");
    expect(markup.indexOf(">Cancel</button>")).toBeLessThan(markup.indexOf(">Delete group chat</button>"));
    expect(markup).toContain("bg-danger");
  });

  it("keeps the room's name intact in other languages", () => {
    setLocale("pt-br");
    expect(roomDeleteCopy({ name: "Launch plan" }).title).toContain("Launch plan");
    expect(roomDeleteCopy({ name: "Launch plan" }).confirmLabel).toBe(t("sidebar.room.deleteChannel"));
  });
});
