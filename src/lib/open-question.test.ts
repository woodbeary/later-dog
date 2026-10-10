import { describe, expect, it } from "vitest";

import type { Message, OptionCardData } from "@/state/store";
import { openQuestion } from "./open-question";

const card = (id: string, extra: Partial<OptionCardData> = {}): Message => ({
  id,
  role: "bot",
  kind: "options",
  at: 1,
  card: { title: "Your dog has a question", subtitle: "", options: [], requestId: `req-${id}`, requestType: "question", ...extra },
});

describe("openQuestion", () => {
  it("finds the first question still waiting for an answer", () => {
    const messages = [
      card("answered", { answered: "Red" }),
      card("approval", { requestType: "permission", tool: "Bash" }),
      card("open"),
      card("later"),
    ];
    expect(openQuestion(messages)).toEqual({ id: "req-open", message: messages[2] });
  });

  it("skips closed, expired and plain cards", () => {
    expect(openQuestion([
      card("dismissed", { dismissed: true }),
      card("expired", { expired: true }),
      card("plain", { requestId: undefined }),
    ])).toBeUndefined();
    expect(openQuestion([])).toBeUndefined();
  });
});
