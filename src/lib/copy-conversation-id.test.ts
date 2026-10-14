import { afterEach, describe, expect, it, vi } from "vitest";

import { copyConversationId } from "./copy-conversation-id";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Copy conversation ID", () => {
  it("puts only the id on the clipboard, never a link", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyConversationId(" 9322b47c-e137-4546-8c88-a8f11f6fbc56 ")).toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("9322b47c-e137-4546-8c88-a8f11f6fbc56");
  });
});
