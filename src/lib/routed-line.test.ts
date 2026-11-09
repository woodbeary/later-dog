import { describe, expect, it } from "vitest";

import { crossEngine, routedLine, withEngine, type RoutedAccount } from "./routed-line";

const chatgpt: RoutedAccount = { instanceId: "codex", driverKind: "codex", displayName: "ChatGPT", snapshot: { authenticated: true } };
const jacob: RoutedAccount = { instanceId: "claude", driverKind: "claudeAgent", displayName: "jacob", snapshot: { authenticated: true } };
const work: RoutedAccount = { instanceId: "claude-work", driverKind: "claudeAgent", displayName: "work", snapshot: { authenticated: true } };

describe("routedLine", () => {
  it("names both engines when the home moves a chat across engines", () => {
    expect(crossEngine(chatgpt, jacob)).toBe(true);
    expect(routedLine({ ...chatgpt, enabled: false }, jacob, false)).toBe("ChatGPT is off, running on jacob (Claude)");
    expect(routedLine(chatgpt, jacob, true)).toBe("ChatGPT is used up, running on jacob (Claude)");
    expect(routedLine({ ...chatgpt, snapshot: { authenticated: false } }, jacob, false)).toBe("ChatGPT is signed out, running on jacob (Claude)");
    expect(routedLine(chatgpt, jacob, false)).toBe("Running on jacob (Claude)");
  });

  it("keeps plain account names within one engine and says nothing when not moved", () => {
    expect(crossEngine(work, jacob)).toBe(false);
    expect(routedLine(work, jacob, true)).toBe("work is used up, running on jacob");
    expect(routedLine(jacob, jacob, true)).toBeNull();
    expect(routedLine(undefined, jacob, false)).toBeNull();
  });

  it("does not repeat an engine already in the account name", () => {
    expect(withEngine({ ...jacob, displayName: "Claude work" })).toBe("Claude work");
    expect(withEngine({ ...jacob, driverKind: "grokAgent" })).toBe("jacob");
  });
});
