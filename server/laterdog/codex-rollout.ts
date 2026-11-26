import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { jsonParser } from "stream-json/core/parser.js";
import { engineFilePath, type EngineFileRoot } from "./engine-files.ts";

export const CODEX_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROLLOUT = /^(?:\d{4}\/\d{2}\/\d{2}\/rollout-[a-zA-Z0-9_.-]+)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/;
const BLOCK = 1024 * 1024;

export function validatedCodexRollout(name: string, cursor: string): string {
  if (!CODEX_UUID.test(cursor) || ROLLOUT.exec(name)?.[1] !== cursor) throw new Error("Codex returned an unexpected checkpoint path.");
  return name;
}

async function* blocks(fd: FileHandle, start: number, end: number, size = BLOCK): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.min(size, end - start));
  while (start < end) {
    const { bytesRead: read } = await fd.read(buffer, 0, Math.min(buffer.length, end - start), start);
    if (!read) throw new Error("The native Codex checkpoint was truncated.");
    start += read;
    yield buffer.subarray(0, read);
  }
}

async function matchesRow(fd: FileHandle, start: number, end: number, rowType: string, identityKey: string, identity: string, eventType?: string): Promise<boolean> {
  const parse = jsonParser({ packValues: false, streamKeys: true, streamStrings: true, streamNumbers: false });
  const decoder = new StringDecoder("utf8");
  let depth = 0, payload = false, key = "", value = "", type = "", event = "", turn = "";
  const read = (text: string) => {
    const parsed = parse(text);
    if (typeof parsed === "symbol") return;
    for (const token of parsed.values) {
      if (token.name === "startObject" || token.name === "startArray") {
        if (depth === 1) payload = token.name === "startObject" && key === "payload";
        depth++;
        key = "";
      } else if (token.name === "endObject" || token.name === "endArray") {
        depth--;
        if (depth === 1) payload = false;
        key = "";
      } else if (token.name === "startKey" || token.name === "startString") {
        value = "";
      } else if (token.name === "stringChunk") {
        if (value.length <= 64) value += token.value.slice(0, 65 - value.length);
      } else if (token.name === "endKey") {
        key = value;
        if (depth === 1 && key === "type") type = "";
        if (depth === 1 && key === "payload") { event = ""; turn = ""; }
        if (depth === 2 && payload && key === "type") event = "";
        if (depth === 2 && payload && key === identityKey) turn = "";
      } else if (token.name === "endString") {
        if (depth === 1 && key === "type") type = value;
        if (depth === 2 && payload && key === "type") event = value;
        if (depth === 2 && payload && key === identityKey) turn = value;
        key = "";
      }
    }
  };
  for await (const piece of blocks(fd, start, end, 32 * 1024)) read(decoder.write(piece));
  read(decoder.end() + "\n");
  return depth === 0 && type === rowType && (!eventType || event === eventType) && turn === identity;
}

export async function inspectCodexRollout(root: EngineFileRoot, name: string, cursor: string, output?: FileHandle, turnId?: string) {
  const path = engineFilePath(root, validatedCodexRollout(name, cursor));
  if (turnId !== undefined && !CODEX_UUID.test(turnId)) throw new Error("The native Codex checkpoint omitted the completed turn.");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new Error("The native Codex checkpoint is not a regular file.");
    let headerEnd = 0;
    for await (const bytes of blocks(fd, 0, stat.size, 32 * 1024)) {
      const newline = bytes.indexOf(10);
      headerEnd += newline < 0 ? bytes.length : newline;
      if (newline >= 0) break;
    }
    if (headerEnd < 1 || headerEnd === stat.size) throw new Error("The native Codex checkpoint is incomplete.");
    if (!await matchesRow(fd, 0, headerEnd, "session_meta", "id", cursor)) throw new Error("The native Codex checkpoint belongs to another session.");
    const hash = createHash("sha256");
    const marker = turnId ? Buffer.from(turnId) : null;
    let offset = 0, rowStart = 0, matched = false, complete = false;
    let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    for await (const bytes of blocks(fd, 0, stat.size)) {
      hash.update(bytes);
      if (output) await output.writeFile(bytes);
      if (marker && turnId && !complete) {
        let from = 0;
        while (from < bytes.length) {
          const end = bytes.indexOf(10, from);
          const part = bytes.subarray(from, end === -1 ? bytes.length : end);
          if (!matched) {
            matched = part.includes(marker) || (tail.length > 0 && Buffer.concat([tail, part.subarray(0, marker.length - 1)]).includes(marker));
            if (end === -1) tail = Buffer.from(Buffer.concat([tail, part.subarray(Math.max(0, part.length - marker.length + 1))]).subarray(1 - marker.length));
          }
          if (end === -1) break;
          if (matched && await matchesRow(fd, rowStart, offset + end, "event_msg", "turn_id", turnId, "task_complete")) { complete = true; break; }
          rowStart = offset + end + 1;
          tail = Buffer.alloc(0);
          matched = false;
          from = end + 1;
        }
      }
      offset += bytes.length;
    }
    const after = await fd.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("The native Codex checkpoint changed during verification.");
    if (turnId && !complete) throw new Error("The native Codex checkpoint omitted the completed turn.");
    return { hash: hash.digest("hex"), size: stat.size, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } };
  } finally { await fd.close(); }
}
