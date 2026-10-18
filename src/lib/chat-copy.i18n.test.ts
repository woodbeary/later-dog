import { afterEach, describe, expect, it } from "vitest";

import { activeLocale, setLocale } from "./i18n";
import { liveActivityLabel } from "./live-activity";
import { replyAuthor, replySnippet } from "./replies";
import type { Message } from "@/state/store";

const activity = (name: string, extra: Record<string, unknown> = {}): Message =>
  ({ id: "a", at: 1, role: "bot", kind: "activity", tool: { ...extra, name } }) as Message;

afterEach(() => {
  setLocale("en");
});

describe("live activity label", () => {
  it("translates the fallback table, which is built once at import time", () => {
    setLocale("pt-br");
    expect(liveActivityLabel()).toBe("Pensando");
    expect(liveActivityLabel(activity("Bash: pnpm test"))).toBe("Executando um comando");
    expect(liveActivityLabel(activity("mcp__computer__click"))).toBe("Usando o computador");

    setLocale("ja");
    expect(liveActivityLabel(activity("web_search"))).toBe("ウェブを検索中");
    expect(liveActivityLabel(activity("something_unknown"))).toBe("作業中");
  });

  it("leaves the server's own narration alone", () => {
    setLocale("pt-br");
    expect(liveActivityLabel(activity("Edit", { spoken: "editando um arquivo" }))).toBe(
      "Editando um arquivo",
    );
  });
});

describe("the memo key the transcript uses", () => {
  it("reports the locale that took effect, after fallback", () => {
    expect(setLocale("pt-BR")).toBe("pt-br");
    expect(activeLocale()).toBe("pt-br");
    setLocale("de-AT");
    expect(activeLocale()).toBe("de");
    setLocale("xx-YY");
    expect(activeLocale()).toBe("en");
  });
});

describe("reply quote", () => {
  it("names the author and the stripped attachments in the reader's language", () => {
    setLocale("pt-br");
    const fromUser = { id: "m", at: 1, role: "user", kind: "text" } as Message;
    expect(replyAuthor(fromUser)).toBe("Você");
    expect(replyAuthor({ ...fromUser, role: "bot" } as Message)).toBe("Assistente");
    expect(replySnippet('<attached-image path="/tmp/a.png" />')).toBe("[imagem]");
  });
});
