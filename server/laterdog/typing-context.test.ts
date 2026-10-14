import { describe, expect, it } from "vitest";
import {
  TYPING_MAX_MESSAGES,
  TYPING_MAX_OUTPUT_TOKENS,
  TYPING_TEMPERATURE,
  finishCompletion,
  looksSecret,
  parseTypingRequest,
  plainContext,
  redactSecrets,
  typingModelInput,
} from "./typing-context.ts";

const SECRETS = [
  `sk-${"a1".repeat(16)}`,
  `ldt_${"B".repeat(43)}`,
  `ghp_${"x9".repeat(15)}`,
  `xoxb-123456789012-abcdefghij`,
  "AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefgh",
  "password: hunter2hunter",
  "the api key is 9f8e7d6c5b4a",
  "0123456789abcdef0123456789abcdef",
  "postgres://admin:s3cretpass@db.example.com/app",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
  "Authorization: Bearer abcdefghijklmnop1234",
];

describe("what never leaves the machine", () => {
  it("recognises secrets in the shapes people paste them", () => {
    for (const secret of SECRETS) expect(looksSecret(`here: ${secret}`), secret).toBe(true);
  });

  it("leaves ordinary writing alone", () => {
    for (const text of ["Can you fix the token refresh bug", "please update the readme and open a PR", "the password field is too narrow", "Deploy to staging at 3pm", "version 1.2.3 of the thing"]) {
      expect(looksSecret(text), text).toBe(false);
    }
  });

  it("hides secrets in messages before they are sent", () => {
    for (const secret of SECRETS) expect(redactSecrets(`use ${secret} now`), secret).not.toContain(secret.split(/\s/).pop()!);
    expect(plainContext("see sk-" + "z".repeat(30) + " ok", 200)).toBe("see [hidden] ok");
  });

  it("drops attachments, code and file paths, which can carry file contents", () => {
    const text = [
      "Look at this <attached-image path=\"/Users/me/shot.png\"> and",
      "```ts\nconst secret = 1;\n```",
      "also /Users/me/code/app/.env please",
    ].join(" ");
    const out = plainContext(text, 400);
    expect(out).not.toContain("shot.png");
    expect(out).not.toContain("const secret");
    expect(out).not.toContain(".env");
    expect(out).toContain("Look at this");
    expect(out).toContain("please");
  });
});

describe("the request the app accepts", () => {
  it("keeps the last few messages, the dog's name and a few of the person's phrases", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? "dog" : "person", text: `message ${index}` }));
    const parsed = parseTypingRequest({ prefix: "Please ", dog: "Rex", messages, phrasing: ["a", "b", "c", "d"] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.messages).toHaveLength(TYPING_MAX_MESSAGES);
    expect(parsed.request.messages.at(-1)?.text).toBe("message 8");
    expect(parsed.request.phrasing).toEqual(["a", "b", "c"]);
    expect(parsed.request.dog).toBe("Rex");
  });

  it("refuses what is not a typing request", () => {
    for (const bad of [null, [], {}, { prefix: "" }, { prefix: 4 }, { prefix: "x".repeat(2_000) }, { prefix: "a", messages: "x" }, { prefix: "a", messages: [{ role: "bot", text: "x" }] }, { prefix: "a", phrasing: [3] }]) {
      expect(parseTypingRequest(bad).ok, JSON.stringify(bad)?.slice(0, 40)).toBe(false);
    }
  });

  it("sends the model a small chat with few output tokens and low temperature", () => {
    const parsed = parseTypingRequest({ prefix: "Please fix ", dog: "Rex", messages: [{ role: "dog", text: "Two tests fail." }], phrasing: ["Can you look at"] });
    if (!parsed.ok) throw new Error("parse");
    const input = typingModelInput(parsed.request);
    expect(input.max_tokens).toBe(TYPING_MAX_OUTPUT_TOKENS);
    expect(input.temperature).toBe(TYPING_TEMPERATURE);
    expect(input.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(input.messages[1]!.content).toContain("Rex: Two tests fail.");
  });
});

describe("what comes back", () => {
  it("is a short single line that continues the typed text", () => {
    expect(finishCompletion("Please fix ", "the failing tests")).toBe("the failing tests");
    expect(finishCompletion("Please fix", " the failing tests")).toBe(" the failing tests");
    expect(finishCompletion("Please fix", "Please fix the failing tests")).toBe(" the failing tests");
    expect(finishCompletion("Can you fi", "x the build\nand more")).toBe("x the build");
    expect(finishCompletion("a", "w ".repeat(40)).split(" ").length).toBeLessThanOrEqual(12);
    expect(finishCompletion("a", "")).toBe("");
  });

  it("never completes with a secret", () => {
    expect(finishCompletion("use ", `sk-${"q".repeat(30)}`)).toBe("");
  });
});
