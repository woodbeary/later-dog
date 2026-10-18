import { describe, expect, it } from "vitest";

import { roomIdentityPrompt } from "./room-prompt.ts";

describe("roomIdentityPrompt", () => {
  it("says who the dog is, who is in the chat and how to bring a dog in, and nothing else", () => {
    expect(roomIdentityPrompt({
      dogName: "Biscuit",
      title: "Research",
      description: "Finds sources.",
      roomName: "Launch",
      roster: "Biscuit (you), Rex [id: rex]",
      personName: "Jacob",
    })).toMatchInlineSnapshot(`
      "You are Biscuit, a dog in the group chat "Launch" in later.dog.
      Role: Research.
      About: Finds sources.
      Members: Biscuit (you), Rex [id: rex], and Jacob (the person).
      Reply as yourself, briefly and conversationally. To bring another dog in, mention them like @Name; they see the conversation and answer."
    `);
  });

  it("leaves out an empty role and about, and never carries room instructions, goals or memory", () => {
    const prompt = roomIdentityPrompt({ dogName: "Rex", roomName: "Ops", roster: "Rex (you)", personName: "Jacob" });
    expect(prompt).not.toContain("Role:");
    expect(prompt).not.toContain("About:");
    expect(prompt).not.toMatch(/bulletin|instructions|goal|team memory|pack/i);
    expect(prompt).toContain("@Name");
  });
});
