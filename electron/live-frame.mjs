export const LIVE_FRAME_MAX_BYTES = 1024 * 1024;
const STEPS = [[1280, 60], [960, 50], [640, 40]];

export async function liveFrame(image) {
  if (!image || image.isEmpty()) throw new Error("The screen picture was empty");
  const { width } = image.getSize();
  let bytes = null;
  for (const [limit, quality] of STEPS) {
    const sized = width > limit ? image.resize({ width: limit, quality: "good" }) : image;
    bytes = sized.toJPEG(quality);
    if (bytes.length <= LIVE_FRAME_MAX_BYTES) break;
  }
  if (!bytes || bytes.length > LIVE_FRAME_MAX_BYTES) throw new Error("The screen picture stayed too large");
  return { data: bytes.toString("base64"), mime: "image/jpeg" };
}
