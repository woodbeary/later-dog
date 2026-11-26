import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { BOOT_CLOUD_SECRETS } from "../cloud-secrets-boot.ts";
import { z } from "zod";

export const PREVIOUS_BACKUP_REFERENCE = "backup-reference.json";
export const ARCHIVE_READ_BYTES = 8 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  size = z
    .number()
    .int()
    .positive()
    .max(10 * 1024 ** 3 + 256 * 1024 ** 2);
const referenceSchema = z.discriminatedUnion("source", [
  z.object({ v: z.literal(1), source: z.literal("baseline"), baseline: hash, size }).strict(),
  z
    .object({
      v: z.literal(1),
      source: z.literal("archive"),
      size,
      sha256: hash,
      chunks: z.array(hash).max(1400),
      signature: hash,
    })
    .strict(),
]);
export type PreviousBackupReference = z.infer<typeof referenceSchema>;
export interface BackupBytes {
  size: number;
  read(position: number, length: number): Promise<Buffer>;
}

export function previousBackupReference(folder: string): PreviousBackupReference | null {
  let fd: number;
  try {
    fd = openSync(
      join(folder, PREVIOUS_BACKUP_REFERENCE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) throw new Error("Invalid saved previous backup reference.");
    return referenceSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function previousBackupBridge(
  url = process.env.LATERDOG_CLOUD_ARCHIVE_URL,
  token = BOOT_CLOUD_SECRETS.LATERDOG_CLOUD_ARCHIVE_TOKEN,
) {
  if (!url || !token) throw new Error("The previous cloud backup store is unavailable.");
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("Invalid local previous cloud backup store.");
  async function call(route: string, body: Buffer | string) {
    const response = await fetch(new URL("/previous-cloud/" + route, endpoint), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": typeof body === "string" ? "application/json" : "application/octet-stream",
      },
      body: body as NonNullable<RequestInit["body"]>,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Previous cloud backup " + route + " failed (" + response.status + ").");
    return response;
  }
  return {
    source(reference: PreviousBackupReference): BackupBytes {
      return {
        size: reference.size,
        read: async (position, length) => {
          const res = await call("range", JSON.stringify({ reference, offset: position, length }));
          const data = Buffer.from(await res.arrayBuffer());
          if (data.length !== length) throw new Error("Incomplete previous cloud backup.");
          return data;
        },
      };
    },
    async seal(path: string): Promise<PreviousBackupReference> {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const original = await handle.stat({ bigint: true });
        const total = size.parse(Number(original.size));
        if (!original.isFile()) throw new Error("Invalid previous cloud backup file.");
        const blocks: { sha256: string; tag: string }[] = [],
          sha = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(total, ARCHIVE_READ_BYTES));
        for (let pos = 0; pos < total; ) {
          const length = Math.min(buffer.length, total - pos);
          for (let filled = 0; filled < length; ) {
            const { bytesRead } = await handle.read(buffer, filled, length - filled, pos + filled);
            if (!bytesRead) throw new Error("Previous cloud backup changed.");
            filled += bytesRead;
          }
          const chunk = buffer.subarray(0, length);
          sha.update(chunk);
          const block = (await (await call("block", chunk)).json()) as { sha256: string; tag: string };
          if (block.sha256 !== createHash("sha256").update(chunk).digest("hex") || !hash.safeParse(block.tag).success)
            throw new Error("Previous cloud backup readback mismatch.");
          blocks.push(block);
          pos += length;
        }
        const current = await handle.stat({ bigint: true });
        if (current.ctimeNs !== original.ctimeNs || current.size !== original.size)
          throw new Error("Previous cloud backup changed.");
        const sha256 = sha.digest("hex");
        const result = referenceSchema.parse(
          await (await call("seal", JSON.stringify({ size: total, sha256, blocks }))).json(),
        );
        if (result.source !== "archive" || result.sha256 !== sha256 || result.size !== total)
          throw new Error("Incomplete previous cloud backup receipt.");
        return result;
      } finally {
        await handle.close();
      }
    },
  };
}
