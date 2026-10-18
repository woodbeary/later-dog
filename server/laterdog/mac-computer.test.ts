import { describe, expect, it } from "vitest";
import { availableTools, type CatalogProfile } from "../drivers/agents-catalog.ts";
import { COMPUTER_RULE, MAC_OFFLINE_RESULT, isMacOffline, macOfflineResult, macOption, macOptions, macSelectReply, taskNeedsMac } from "./mac-computer.ts";

const profile = (overrides: Partial<CatalogProfile> = {}): CatalogProfile => ({
  externalRuntime: false, coordinating: false, skillAuthoring: false,
  sharedComputers: true, voiceNotes: false, cloudHome: true, chief: false, botId: "bot-1", ...overrides,
});
const online = [{ name: "Jo's MacBook", online: true }];
const offline = [{ name: "Jo's MacBook", online: false }];

describe("the owner's Mac as a computer on a Cloud home", () => {
  it("is a selectable computer next to the dog's own, ready only while online", () => {
    expect(macOption(online)).toMatchObject({ surface: "mac", label: "Your Mac", available: true, ready: true });
    expect(macOption(offline)).toMatchObject({ available: false, ready: false, reason: MAC_OFFLINE_RESULT });
    expect(macOptions([])).toEqual([]);
  });

  it("stays out of auto unless the task needs something only the Mac has", () => {
    expect(macSelectReply("auto", undefined, online)).toBeNull();
    expect(macSelectReply("auto", "write a landing page", online)).toBeNull();
    expect(macSelectReply("cloud", "file in Downloads", online)).toBeNull();
    for (const needs of ["a file in Downloads", "the PDF on my Desktop", "something in Documents", "local project folder", "an app signed in there"]) {
      expect(macSelectReply("auto", needs, online)).toMatchObject({ status: "ready", surface: "mac" });
    }
    expect(taskNeedsMac(42)).toBe(false);
  });

  it("answers an offline Mac by telling the person to open the later.dog app, not with an error", () => {
    expect(MAC_OFFLINE_RESULT).toContain("Open the later.dog app on your Mac.");
    expect(macSelectReply("mac", undefined, offline)).toEqual({ status: "offline", surface: "mac", message: MAC_OFFLINE_RESULT });
    expect(macSelectReply("auto", "file in Downloads", offline)?.status).toBe("offline");
    expect(macOfflineResult()).toEqual({ content: [{ type: "text", text: MAC_OFFLINE_RESULT }] });
    expect(isMacOffline(Object.assign(new Error("x"), { macOffline: true }))).toBe(true);
    expect(isMacOffline(new Error("x"))).toBe(false);
  });

  it("tells the dog how to get a Mac connected when none ever attached", () => {
    expect(macSelectReply("mac", undefined, [])?.status).toBe("none");
  });

  it("is explained to the dogs in one rule on select_computer, with mac as a choice", () => {
    const tool = availableTools(profile()).find(entry => entry.name === "select_computer")!;
    expect(tool.description.startsWith(COMPUTER_RULE)).toBe(true);
    expect(tool.description).toContain("Don't ask which one to use.");
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(properties.surface!.enum).toEqual(["auto", "cloud", "mac"]);
    expect(properties.needs).toBeDefined();
    const shared = availableTools(profile()).find(entry => entry.name === "shared_computer")!;
    expect(shared.description).toContain("no card");
    expect(availableTools(profile({ cloudHome: false })).find(entry => entry.name === "select_computer")!.description).not.toContain(COMPUTER_RULE);
  });
});
