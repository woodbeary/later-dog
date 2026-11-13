import { describe, expect, it } from "vitest";

import { crossEngine, routedLine, withEngine, type RoutedAccount } from "./routed-line";

const chatgpt: RoutedAccount = { instanceId: "codex", driverKind: "codex", displayName: "ChatGPT" };
const jacob: RoutedAccount = { instanceId: "claude", driverKind: "claudeAgent", displayName: "jacob" };
const daniel: RoutedAccount = { instanceId: "claude-daniel", driverKind: "claudeAgent", displayName: "daniel" };

describe("routedLine", () => {
  it("says where the chat runs until the chosen account is back", () => {
    expect(routedLine(daniel, jacob, false)).toBe("Running on jacob until daniel is back");
  });

  it("says From the next message when the choice takes effect on the next message", () => {
    expect(routedLine(daniel, jacob, true)).toBe("From the next message");
  });

  it("names both engines only when a person moved the chat across engines by hand", () => {
    expect(crossEngine(chatgpt, jacob)).toBe(true);
    expect(routedLine(chatgpt, jacob, false)).toBe("Running on jacob (Claude) until ChatGPT is back");
  });

  it("says nothing when the chat runs on the chosen account", () => {
    expect(crossEngine(daniel, jacob)).toBe(false);
    expect(routedLine(jacob, jacob, false)).toBeNull();
    expect(routedLine(undefined, jacob, false)).toBeNull();
  });

  it("does not repeat an engine already in the account name", () => {
    expect(withEngine({ ...jacob, displayName: "Claude work" })).toBe("Claude work");
    expect(withEngine({ ...jacob, driverKind: "grokAgent" })).toBe("jacob");
  });
});
