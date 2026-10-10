import { describe, expect, it } from "vitest";

import type { Attachment } from "./composer-attachments";
import { admitPictures, joinNotices } from "./picture-limit";

const file = (name: string, type: string) => ({ name, type });
const isPicture = (entry: { type: string }) => entry.type.startsWith("image/");
const picture = (id: string): Attachment => ({ kind: "image", id, name: `${id}.png`, path: `/a/${id}.png` }) as Attachment;
const document = (id: string): Attachment => ({ kind: "file", id, name: `${id}.pdf`, path: `/a/${id}.pdf`, size: 1 }) as Attachment;

describe("admitPictures", () => {
  it("takes the first four of six picked pictures and refuses the rest", () => {
    const picked = ["a", "b", "c", "d", "e", "f"].map((name) => file(`${name}.png`, "image/png"));
    const { admitted, refused } = admitPictures(picked, isPicture, []);
    expect(admitted.map((entry) => entry.name)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(refused).toBe(2);
  });

  it("counts the pictures already in the message, uploading or done", () => {
    const { admitted, refused } = admitPictures([file("e.png", "image/png"), file("f.png", "image/png")], isPicture, [picture("1"), picture("2"), picture("3")]);
    expect(admitted.map((entry) => entry.name)).toEqual(["e.png"]);
    expect(refused).toBe(1);
  });

  it("never limits files that aren't pictures, and attached documents don't use up picture room", () => {
    const picked = [file("notes.pdf", "application/pdf"), file("a.png", "image/png"), file("data.csv", "text/csv")];
    const { admitted, refused } = admitPictures(picked, isPicture, [picture("1"), picture("2"), picture("3"), picture("4"), document("x")]);
    expect(admitted.map((entry) => entry.name)).toEqual(["notes.pdf", "data.csv"]);
    expect(refused).toBe(1);
    expect(admitPictures([file("a.png", "image/png")], isPicture, [document("x"), document("y"), document("z"), document("w")]).refused).toBe(0);
  });
});

describe("joinNotices", () => {
  it("shows every notice that has words, and nothing when none do", () => {
    expect(joinNotices("A message can have up to 4 pictures.", "notes.md: upload failed")).toBe("A message can have up to 4 pictures. notes.md: upload failed");
    expect(joinNotices(null, "notes.md: upload failed")).toBe("notes.md: upload failed");
    expect(joinNotices(null, undefined)).toBeNull();
  });
});
