import { describe, expect, it } from "vitest";

import { directApply, ownerModelApply } from "./direct-apply.ts";

describe("directApply", () => {
  it("applies everything at Full access, unchanged", () => {
    expect(directApply({ fullAccess: true, botId: "a", targetBotId: "b", blocked: false })).toBe("full-access");
    expect(directApply({ fullAccess: true, botId: "a", targetBotId: "a", blocked: false })).toBe("full-access");
  });

  it("applies a bot's change to itself at any other level", () => {
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "a", blocked: false })).toBe("self");
  });

  it("keeps the card for another bot, and for everything in a guest-driven turn", () => {
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "b", blocked: false })).toBeNull();
    expect(directApply({ fullAccess: false, botId: "a", targetBotId: "a", blocked: true })).toBeNull();
  });
});

describe("changing another of the owner's dogs' model", () => {
  it("applies at once for a dog working for the owner, with the same Undo as a change to itself", () => {
    expect(ownerModelApply({ direct: null, crossBot: true, ownerWork: true, connected: true })).toBe("owner-auto");
    expect(ownerModelApply({ direct: "self", crossBot: false, ownerWork: true, connected: true })).toBe("self");
  });

  it("waits for the owner when the dog isn't working for the owner", () => {
    expect(ownerModelApply({ direct: null, crossBot: true, ownerWork: false, connected: true })).toBeNull();
    expect(ownerModelApply({ direct: null, crossBot: true, ownerWork: true, connected: false })).toBeNull();
  });
});
