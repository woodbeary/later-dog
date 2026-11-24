import assert from "node:assert/strict";
import { test } from "node:test";
import { liveFrame, LIVE_FRAME_MAX_BYTES } from "./live-frame.mjs";

const fakeImage = (width, height, bytesFor) => ({
  isEmpty: () => width === 0,
  getSize: () => ({ width, height }),
  resize: ({ width: next }) => fakeImage(next, Math.round(height * next / width), bytesFor),
  toJPEG: quality => Buffer.alloc(bytesFor(width, quality)),
});

test("a Retina screen is shrunk to 1280 wide and sent as a JPEG", async () => {
  const sizes = [];
  const frame = await liveFrame(fakeImage(2560, 1600, (width, quality) => { sizes.push([width, quality]); return 145_000; }));
  assert.equal(frame.mime, "image/jpeg");
  assert.equal(Buffer.from(frame.data, "base64").length, 145_000);
  assert.deepEqual(sizes, [[1280, 60]]);
});

test("a small screen is not blown up", async () => {
  const sizes = [];
  await liveFrame(fakeImage(1024, 640, (width, quality) => { sizes.push([width, quality]); return 90_000; }));
  assert.deepEqual(sizes, [[1024, 60]]);
});

test("a busy screen that stays over 1 MB is shrunk further until it fits", async () => {
  const frame = await liveFrame(fakeImage(2560, 1600, width => width > 900 ? 1_300_000 : 400_000));
  assert.ok(Buffer.from(frame.data, "base64").length <= LIVE_FRAME_MAX_BYTES);
});

test("an empty picture is refused", async () => {
  await assert.rejects(liveFrame(fakeImage(0, 0, () => 0)), /empty/);
});
