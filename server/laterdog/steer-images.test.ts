import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "laterdog-steer-images-"));
vi.mock("../attachments.ts", async (original) => ({
  ...(await original<typeof import("../attachments.ts")>()),
  ATTACHMENTS_DIR: dir,
}));

const { steerWords } = await import("./steer-images.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("steerWords", () => {
  it("passes plain words through untouched", () => {
    expect(steerWords("keep going")).toEqual({ text: "keep going" });
  });

  it("lifts an owned picture out of the words", () => {
    const path = join(dir, "123e4567-e89b-42d3-a456-426614174000.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const words = steerWords(`look at this\n\n<attached-image path="${path}" name="shot.png" />`);
    expect(words.images).toEqual([{ path, mime: "image/png", bytes: 4 }]);
    expect(words.text.trim()).toBe("look at this");
  });

  it("leaves a picture it does not own as words", () => {
    const text = 'look\n\n<attached-image path="/etc/passwd.png" name="x.png" />';
    expect(steerWords(text)).toEqual({ text });
  });
});
