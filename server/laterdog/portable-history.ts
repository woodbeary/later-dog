import { BOOT_CLOUD_SECRETS } from "../cloud-secrets-boot.ts";
import {
  portableHistoryContents,
  portableHistorySnapshot,
} from "../../deploy/laterdog/home/migration/history/portable.mjs";

export interface HistoryBackupAccess {
  url: string;
  token: string;
  generation: string;
}

export function activeHistoryBackup(): HistoryBackupAccess | undefined {
  if (process.env.LATERDOG_HISTORY_MODE !== "remote") return;
  const url = process.env.LATERDOG_HISTORY_URL,
    generation = process.env.LATERDOG_HISTORY_GENERATION,
    token = BOOT_CLOUD_SECRETS.LATERDOG_HISTORY_TOKEN;
  if (!url || !generation || !token)
    throw Error("Conversation history backup is unavailable");
  return { url, token, generation };
}

function requests(access: HistoryBackupAccess) {
  const base = new URL(access.url);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("Invalid history backup connection");
  return async (route: string, body?: unknown) => {
    const res = await fetch(access.url + "/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer " + access.token,
        "content-type": "application/json",
      },
      redirect: "error",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw Error(
        "Conversation history backup request failed (" + res.status + ")",
      );
    }
    return res.json();
  };
}

export function exportPortableHistory(
  access: HistoryBackupAccess,
  source: string,
  target: string,
) {
  const request = requests(access);
  return portableHistorySnapshot(request, access.generation, source, target, {
    receiptBatch: (q) =>
      request("receipts-batch", {
        generation: access.generation,
        ...(q as object),
      }),
    async getReceipt(sha) {
      const res = await fetch(
        access.url +
          "/receipts/" +
          encodeURIComponent(access.generation) +
          "/" +
          sha,
        {
          headers: { authorization: "Bearer " + access.token },
          redirect: "error",
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (!res.ok || !res.body)
        throw Error("Missing conversation command receipt");
      return res.body;
    },
  });
}
export function portableHistorySize(access: HistoryBackupAccess) {
  return portableHistoryContents(requests(access), access.generation);
}
