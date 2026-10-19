export const CARRY_PART_BYTES = 1024 * 1024;
export const CARRY_MAX_BYTES = 1024 * 1024 * 1024;
export const CARRY_TIMEOUT_MS = 10 * 60_000;
export const CARRY_HOME = "/home/dog";

export const PACK_SCRIPT = `tar -C ${CARRY_HOME} --exclude=./.cache --exclude='./.config/chromium/Singleton*' --warning=no-file-changed --ignore-failed-read -czf - .; code=$?; [ "$code" -le 1 ] || exit "$code"`;
export const UNPACK_SCRIPT = `tar -C ${CARRY_HOME} -xzpf -`;

export interface Carry {
  parts: number;
  bytes: number;
  from?: { id: string; size: number; name?: string };
}

export const carryPartKey = (index: number) => `carry:${index}`;

export type Stored = { ok: true; parts: number; bytes: number } | { ok: false; tooLarge: true; parts: number };

export async function storeParts(stream: ReadableStream<Uint8Array> | null, put: (key: string, part: Uint8Array) => void, limit = CARRY_MAX_BYTES): Promise<Stored> {
  if (!stream) return { ok: true, parts: 0, bytes: 0 };
  const reader = stream.getReader();
  let pending = new Uint8Array(CARRY_PART_BYTES);
  let filled = 0;
  let parts = 0;
  let bytes = 0;
  const flush = () => {
    if (filled === 0) return;
    put(carryPartKey(parts), pending.slice(0, filled));
    parts += 1;
    filled = 0;
    pending = new Uint8Array(CARRY_PART_BYTES);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, tooLarge: true, parts };
    }
    let offset = 0;
    while (offset < value.byteLength) {
      const take = Math.min(CARRY_PART_BYTES - filled, value.byteLength - offset);
      pending.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === CARRY_PART_BYTES) flush();
    }
  }
  flush();
  return { ok: true, parts, bytes };
}

export function partsStream(parts: number, get: (key: string) => Uint8Array | undefined): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= parts) {
        controller.close();
        return;
      }
      const part = get(carryPartKey(next));
      next += 1;
      if (!part) {
        controller.error(new Error(`Part ${next - 1} of the carried files is missing.`));
        return;
      }
      controller.enqueue(part);
    },
  });
}
