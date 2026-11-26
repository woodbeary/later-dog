import { acceptedCommands } from "./accepted.mjs";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkpoint, digest, fileHash } from "./sqlite.mjs";
import { writeOnce } from "./package.mjs";
import { fetchThread, listThreads, mapLimit } from "./transfer.mjs";
import { reconstruct } from "./projection.mjs";

async function collectVersions(request, generation) {
  const p = await request("status");
  if (
    p.generation !== generation ||
    p.mode !== "remote" ||
    !Number.isSafeInteger(p.revision)
  )
    throw Error("Conversation history placement changed");
  const ids = await listThreads({
    admin: ({ after }) =>
      request(
        "threads?" +
          new URLSearchParams({
            generation,
            ...(after === undefined ? {} : { after }),
          }),
      ),
  });
  const pages = [];
  for (let i = 0; i < ids.length; i += 32) pages.push(ids.slice(i, i + 32));
  const all = await mapLimit(pages, 4, async (threadIds) => {
    const query = { generation, revision: p.revision, threadIds },
      reply = await request("export-check", query);
    if (!Array.isArray(reply.items) || reply.items.length !== threadIds.length)
      throw Error("Incomplete history version check");
    const byId = new Map(reply.items.map((x) => [x.threadId, x]));
    return threadIds.map((id) => {
      const v = byId.get(id);
      if (
        !v ||
        !Number.isSafeInteger(v.version) ||
        v.version < 0 ||
        typeof v.nativeEventSequence !== "string" ||
        !/^(?:0|[1-9][0-9]{0,18})$/.test(v.nativeEventSequence) ||
        BigInt(v.nativeEventSequence) > 9223372036854775807n
      )
        throw Error("Invalid history version check");
      return v;
    });
  });
  return { generation, revision: p.revision, items: all.flat() };
}

export async function portableHistoryContents(request, generation) {
  const version = await collectVersions(request, generation);
  let chats = 0,
    bytes = 0;
  for (const item of version.items) {
    if (typeof item.hasUserMessage !== "boolean")
      throw Error("Missing conversation inventory");
    if (item.hasUserMessage) chats++;
    if (Number.isSafeInteger(item.bytes) && item.bytes >= 0)
      bytes += item.bytes;
  }
  return { chats, bytes };
}

export async function portableHistorySnapshot(
  request,
  generation,
  source,
  target,
  receiptAccess,
) {
  const pending = join(dirname(source), "history-pending.json");
  if (existsSync(pending))
    throw Error("Pending conversation history must drain before backup");
  const temp = mkdtempSync(join(dirname(target), "history-export-"));
  try {
    const start = await collectVersions(request, generation),
      control = join(temp, "control.db");
    await checkpoint(source, control);
    const sourceSha256 = await fileHash(control);
    const shards = await mapLimit(start.items, 4, async (item) => {
      const api = {
        page: ({ op, ...query }) => {
          if (op !== "page") throw Error("Invalid history export operation");
          return request("export-page", {
            ...query,
            generation,
            revision: start.revision,
            version: item.version,
          });
        },
      };
      const shard = await fetchThread(api, item.threadId, temp);
      if (item.commandHead !== null && typeof item.commandHead !== "string")
        throw Error("Missing accepted command head");
      shard.commands = await acceptedCommands(
        (q) =>
          request("export-commands", {
            ...q,
            generation,
            revision: start.revision,
            version: item.version,
            threadId: item.threadId,
          }),
        temp,
        item.commandHead,
      );
      return shard;
    });
    const end = await collectVersions(request, generation);
    if (existsSync(pending) || !isDeepStrictEqual(start, end))
      throw Error(
        "Conversation history changed during workspace backup. Try the backup again.",
      );
    const eventSequence = start.items.reduce(
      (m, v) =>
        BigInt(v.nativeEventSequence) > BigInt(m) ? v.nativeEventSequence : m,
      "0",
    );
    const fence = {
      v: 1,
      mode: "read",
      generation,
      revision: start.revision,
      versions: digest(JSON.stringify(start.items)),
    };
    const catalog = {
      v: 1,
      generation,
      sourceSha256,
      eventSequence,
      shards,
      fence,
    };
    const raw = Buffer.from(JSON.stringify(catalog)),
      sha256 = digest(raw);
    writeOnce(join(temp, "catalogs", sha256), raw);
    await reconstruct(control, temp, sha256, target, generation, receiptAccess);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
