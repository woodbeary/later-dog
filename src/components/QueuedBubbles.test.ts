// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { QueuedBubbles, queuedMessageParts } from "./QueuedBubbles";
import { citationAttachment, createCitationTextSelector, serializeCitation } from "@/lib/citations";

describe("QueuedBubbles", () => {
  it("shows a waiting message as a full bubble with Cancel", () => {
    const markup = renderToStaticMarkup(createElement(QueuedBubbles, {
      items: [{ queueId: "q1", text: "actually stop at 10\nand use the smaller model" }],
      onCancel: () => undefined,
    }));
    expect(markup).toContain("actually stop at 10\nand use the smaller model");
    expect(markup).toContain('data-queued-bubble="q1"');
    expect(markup).toContain("Not sent yet");
    expect(markup).toContain('aria-label="Cancel this message"');
    expect(markup).not.toContain("Steer");
    expect(markup).not.toContain("truncate");
  });

  it("cancels the message whose Cancel was pressed", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onCancel = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(QueuedBubbles, {
      items: [{ queueId: "q1", text: "first" }, { queueId: "q2", text: "second" }],
      onCancel,
    })));
    act(() => host.querySelector<HTMLButtonElement>('[data-queued-bubble="q2"] button')!.click());
    expect(onCancel).toHaveBeenCalledWith("q2");
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("shows readable citation content instead of transport metadata", () => {
    const citation = citationAttachment(
      { ownerType: "bot", ownerId: "b1", threadId: "t1", messageId: "m1" },
      createCitationTextSelector("selected 🐭 code", 0, 16)!,
      "explain it",
    );
    const markup = renderToStaticMarkup(createElement(QueuedBubbles, {
      items: [{ queueId: "citation", text: serializeCitation(citation) }],
      onCancel: () => undefined,
    }));
    expect(markup).toContain("selected 🐭 code");
    expect(markup).toContain("explain it");
    expect(markup).not.toContain("laterdog-citation-v1");
  });

  it("renders nothing when nothing waits", () => {
    expect(renderToStaticMarkup(createElement(QueuedBubbles, { items: [], onCancel: () => undefined }))).toBe("");
  });
});

describe("queuedMessageParts", () => {
  const picture = '<attached-image path="/home/u/.laterdog/attachments/123e4567-e89b-42d3-a456-426614174000.png" name="shot.png" />';

  it("shows a waiting picture as a thumbnail, never as its file path", () => {
    const parts = queuedMessageParts(`what about this\n\n${picture}`);
    expect(parts.label).toBe("what about this");
    expect(parts.pictures).toEqual(["/api/attachments/123e4567-e89b-42d3-a456-426614174000.png"]);
  });

  it("names a picture sent without words", () => {
    expect(queuedMessageParts(picture)).toEqual({
      label: "A picture",
      pictures: ["/api/attachments/123e4567-e89b-42d3-a456-426614174000.png"],
    });
    expect(queuedMessageParts(`${picture}\n${picture}`).label).toBe("2 pictures");
  });

  it("keeps plain words as they are", () => {
    expect(queuedMessageParts("actually stop at 10")).toEqual({ label: "actually stop at 10", pictures: [] });
  });
});
