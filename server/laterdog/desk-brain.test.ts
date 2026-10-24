import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import {
  createDeskPrompts, createDeskVerifier, DESK_REPLY_MAX_CHARS, deskDogs, deskReplyFrom, deskSignature, deskTranscript, sha256Hex,
} from "./desk-brain.ts";

const SECRET = randomBytes(32).toString("base64url");
const T0 = Date.UTC(2026, 9, 24, 12);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function signed(parts: string[], at = T0, nonce = randomBytes(16).toString("base64url"), secret = SECRET) {
  const timestamp = String(Math.floor(at / 1000));
  return {
    "x-laterdog-cloud-timestamp": timestamp,
    "x-laterdog-cloud-nonce": nonce,
    "x-laterdog-cloud-signature": `v1=${deskSignature(secret, [timestamp, nonce, ...parts])}`,
  };
}

const line = (role: "user" | "bot", text: string, kind: Message["kind"] = "text"): Message => ({ id: randomBytes(4).toString("hex"), at: T0, role, kind, text });

describe("desk signatures", () => {
  it("accept the Worker's signed request once and nothing altered, late or forged", () => {
    const verify = createDeskVerifier({ secret: SECRET, now: () => T0 });
    const headers = signed(["GET", "/api/cloud/desk/brain"]);
    expect(verify(headers, ["GET", "/api/cloud/desk/brain"])).toBe(true);
    expect(verify(headers, ["GET", "/api/cloud/desk/brain"])).toBe(false);
    expect(verify(signed(["GET", "/api/cloud/desk/brain"]), ["GET", "/api/bots"])).toBe(false);
    expect(verify(signed(["GET", "/api/cloud/desk/brain"], T0 - 10 * 60_000), ["GET", "/api/cloud/desk/brain"])).toBe(false);
    expect(verify(signed(["GET", "/api/cloud/desk/brain"], T0, undefined, "another-secret-0000000000000000"), ["GET", "/api/cloud/desk/brain"])).toBe(false);
    expect(verify({}, ["GET", "/api/cloud/desk/brain"])).toBe(false);
  });

  it("take a reply only when it is signed for this send and these exact words", () => {
    const verify = createDeskVerifier({ secret: SECRET, now: () => T0 });
    const path = "/api/bots/rex/messages";
    const reply = { text: "Hi! Good to see you.", model: "kimi-k2.6" };
    const headers = signed(["POST", path, "send-0000000000001", sha256Hex(reply.text)]);
    expect(deskReplyFrom({ verify, headers, path, sendId: "send-0000000000001", reply: { ...reply, text: "Something else." } })).toBeNull();
    expect(deskReplyFrom({ verify, headers: signed(["POST", path, "send-0000000000001", sha256Hex(reply.text)]), path, sendId: "send-0000000000002", reply })).toBeNull();
    expect(deskReplyFrom({ verify, headers, path, sendId: "send-0000000000001", reply })).toEqual(reply);
    expect(deskReplyFrom({ verify, headers: signed(["POST", path, "send-0000000000003", sha256Hex("x")]), path, sendId: undefined, reply: { text: "x", model: "m" } })).toBeNull();
    const long = "a".repeat(DESK_REPLY_MAX_CHARS + 1);
    expect(deskReplyFrom({ verify, headers: signed(["POST", path, "send-0000000000004", sha256Hex(long)]), path, sendId: "send-0000000000004", reply: { text: long, model: "m" } })).toBeNull();
  });
});

describe("what the desk knows about each dog", () => {
  it("keeps the last prompt each free-model chat used, across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-prompts-"));
    dirs.push(dir);
    const file = join(dir, "desk-prompts.json");
    let now = T0;
    const prompts = createDeskPrompts(file, () => now);
    prompts.remember("t-rex", { instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex." });
    now += 1_000;
    prompts.remember("t-rex", { instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex, a good dog." });
    expect(createDeskPrompts(file).get("t-rex")).toEqual({ instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex, a good dog.", at: T0 + 1_000 });
    prompts.remember("t-big", { instanceId: "laterdogAi", model: "kimi-k2.6", system: "x".repeat(200_000) });
    expect(createDeskPrompts(file).get("t-big")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("t-rex");
  });

  it("hands over recent words only, oldest first, as the chat API names them", () => {
    const path = [line("user", "hello"), line("bot", "hi there"), line("bot", "", "activity"), line("user", "how are you?")];
    expect(deskTranscript(path)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ]);
    const many = Array.from({ length: 40 }, (_, index) => line(index % 2 ? "bot" : "user", `line ${index}`));
    expect(deskTranscript(many)).toHaveLength(24);
    expect(deskTranscript(many).at(-1)).toEqual({ role: "assistant", content: "line 39" });
    expect(deskTranscript([line("user", "a".repeat(30_000)), line("user", "short")])).toEqual([{ role: "user", content: "short" }]);
  });

  it("lists only free-model dogs it has a prompt for and that are not working", () => {
    const prompts: Record<string, { instanceId: string; model: string; system: string; at: number }> = {
      "t-rex": { instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex.", at: T0 },
      "t-fido": { instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Fido.", at: T0 },
      "t-claude": { instanceId: "claude", model: "opus", system: "You are Claudia.", at: T0 },
    };
    const dogs = deskDogs({
      bots: [
        { id: "rex", name: "Rex", threadId: "t-rex", modelSelection: { instanceId: "laterdogAi", model: "kimi-k2.6" } },
        { id: "fido", name: "Fido", threadId: "t-fido", modelSelection: { instanceId: "laterdogAi", model: "kimi-k2.6" } },
        { id: "claudia", name: "Claudia", threadId: "t-claude", modelSelection: { instanceId: "claude", model: "opus" } },
        { id: "new", name: "New", threadId: "t-new", modelSelection: { instanceId: "laterdogAi", model: "kimi-k2.6" } },
      ],
      prompt: (threadId) => prompts[threadId],
      path: () => [line("user", "hello")],
      leaf: (threadId) => `${threadId}-leaf`,
      answers: ["laterdogAi", "laterdogGrok"],
      busy: (botId) => botId === "fido",
    });
    expect(dogs).toEqual([{
      botId: "rex", threadId: "t-rex", name: "Rex", instanceId: "laterdogAi", model: "kimi-k2.6", system: "You are Rex.",
      transcript: [{ role: "user", content: "hello" }], leafId: "t-rex-leaf",
    }]);
  });
});
