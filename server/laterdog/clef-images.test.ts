import { describe, expect, it } from "vitest";

import { CLEF_IMAGE_MAX_BYTES, prepareClefImages } from "./clef-images.ts";

const small = Buffer.from("tiny-image-bytes").toString("base64");
const big = Buffer.alloc(CLEF_IMAGE_MAX_BYTES + 10, 7).toString("base64");

describe("preparing screenshots for the decision model", () => {
  it("turns bare base64 and a format into a data URL", async () => {
    await expect(prepareClefImages([{ data: small, format: "jpeg" }])).resolves.toEqual({
      ok: true,
      images: [`data:image/jpeg;base64,${small}`],
    });
  });

  it("keeps a data URL as it is and accepts png, jpeg and webp", async () => {
    const urls = ["image/png", "image/jpeg", "image/webp"].map((mime) => `data:${mime};base64,${small}`);
    await expect(prepareClefImages(urls.map((data) => ({ data })))).resolves.toEqual({ ok: true, images: urls });
  });

  it("refuses other types, broken base64 and more than four images", async () => {
    await expect(prepareClefImages([{ data: `data:image/gif;base64,${small}` }])).resolves.toEqual({ ok: false, reason: "unsupported_type" });
    await expect(prepareClefImages([{ data: small, format: "bmp" }])).resolves.toEqual({ ok: false, reason: "unsupported_type" });
    await expect(prepareClefImages([{ data: "not base64!!", format: "png" }])).resolves.toEqual({ ok: false, reason: "malformed" });
    await expect(prepareClefImages(Array.from({ length: 5 }, () => ({ data: small, format: "png" })))).resolves.toEqual({ ok: false, reason: "too_many" });
  });

  it("refuses an image above the cap when nothing can shrink it", async () => {
    await expect(prepareClefImages([{ data: big, format: "jpeg" }])).resolves.toEqual({ ok: false, reason: "too_large" });
  });

  it("uses a shrinker when one is given, and refuses a shrinker that does not shrink enough", async () => {
    const shrinks = async () => ({ bytes: Buffer.from("small"), mime: "image/jpeg" });
    await expect(prepareClefImages([{ data: big, format: "png" }], { shrink: shrinks })).resolves.toEqual({
      ok: true,
      images: [`data:image/jpeg;base64,${Buffer.from("small").toString("base64")}`],
    });
    const stubborn = async () => ({ bytes: Buffer.alloc(CLEF_IMAGE_MAX_BYTES + 1), mime: "image/jpeg" });
    await expect(prepareClefImages([{ data: big, format: "png" }], { shrink: stubborn })).resolves.toEqual({ ok: false, reason: "too_large" });
    const broken = async () => { throw new Error("boom"); };
    await expect(prepareClefImages([{ data: big, format: "png" }], { shrink: broken })).resolves.toEqual({ ok: false, reason: "too_large" });
  });
});
