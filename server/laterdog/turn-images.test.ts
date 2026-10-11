import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { latestTurnAnswer, postTurnImage, type TurnImageMessage } from "./turn-images.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("postTurnImage", () => {
  it("posts the image at once as its own message on the turn", () => {
    const posted: TurnImageMessage[] = [];
    postTurnImage(PNG, "turn-1", (message) => posted.push(message));

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ role: "bot", kind: "text", text: "", turnId: "turn-1" });
    const [image] = posted[0].attachments ?? [];
    expect(image).toMatchObject({ kind: "image", mime: "image/png" });
    expect(readFileSync(image!.path).equals(Buffer.from(PNG, "base64"))).toBe(true);
  });

  it("removes the saved file when the message cannot be posted", () => {
    let saved = "";
    expect(() => postTurnImage(PNG, "turn-2", (message) => {
      saved = message.attachments?.[0]?.path ?? "";
      throw new Error("store write failed");
    })).toThrow("store write failed");

    expect(saved).not.toBe("");
    expect(existsSync(saved)).toBe(false);
  });

  it("posts nothing for bytes that are not an image", () => {
    const posted: TurnImageMessage[] = [];
    expect(() => postTurnImage(Buffer.from("not an image").toString("base64"), "turn-3", (message) => posted.push(message)))
      .toThrow("not a supported raster format");
    expect(posted).toHaveLength(0);
  });
});

describe("latestTurnAnswer", () => {
  const said = (id: string, fields: Partial<Message>): Message => ({ id, at: 1, role: "bot", kind: "text", ...fields }) as Message;
  const image = [{ kind: "image" as const, path: "/attachments/shot.png", mime: "image/png" }];

  it("skips an image posted after the written answer", () => {
    const answer = said("a", { text: "Here it is.", turnId: "t" });
    const shot = said("b", { text: "", turnId: "t", attachments: image });
    expect(latestTurnAnswer([answer, shot], "t")).toBe(answer);
  });

  it("finds no answer in a turn that only posted images", () => {
    expect(latestTurnAnswer([said("a", { text: "", turnId: "t", attachments: image })], "t")).toBeUndefined();
  });

  it("ignores other turns and the person's own words", () => {
    const earlier = said("a", { text: "Earlier answer.", turnId: "old" });
    const person = said("b", { role: "user", text: "Thanks", turnId: "t" });
    const answer = said("c", { text: "Current answer.", turnId: "t" });
    expect(latestTurnAnswer([earlier, answer, person], "t")).toBe(answer);
    expect(latestTurnAnswer([earlier, person], "t")).toBeUndefined();
  });
});
