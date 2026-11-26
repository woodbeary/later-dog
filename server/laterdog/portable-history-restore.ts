import { stagePortableHistory } from "../../deploy/laterdog/home/migration/history/portable-restore.mjs";
import { BOOT_CLOUD_SECRETS } from "../cloud-secrets-boot.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { initializeMessageDatabase } from "../message-db.ts";
import type { HistoryBackupAccess } from "./portable-history.ts";

export interface HistoryRestoreAccess extends HistoryBackupAccess {
  restoreToken: string;
}
export function restoreHistoryAccess(
  source: HistoryBackupAccess,
): HistoryRestoreAccess {
  const restoreToken = BOOT_CLOUD_SECRETS.LATERDOG_HISTORY_RESTORE_TOKEN;
  if (!restoreToken)
    throw Error("The conversation restore authority is unavailable");
  return { ...source, restoreToken };
}
type Phase = "preparing" | "fencing" | "switched" | "finished" | "undone";
interface Job {
  jobId: string;
  generation: string;
  previousRevision: number;
  physicalGeneration: string;
  status: Phase;
}
export function historyRestoreConnection(
  source: HistoryRestoreAccess,
  jobId: string,
) {
  const { generation, url, token, restoreToken } = source;
  async function call(
    route: string,
    secret: string,
    body?: RequestInit["body"],
    method = body === undefined ? "GET" : "POST",
  ) {
    const result = await fetch(url + "/" + route, {
      method,
      headers: {
        authorization: "Bearer " + secret,
        "content-type":
          typeof body === "string"
            ? "application/json"
            : "application/octet-stream",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      ...(body && typeof body !== "string" ? { duplex: "half" } : {}),
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw Error(
        "Conversation restore request failed (" + result.status + ")",
      );
    }
    return result;
  }
  const json = async (route: string, secret: string, body?: unknown) =>
    (
      await call(
        route,
        secret,
        body === undefined ? undefined : JSON.stringify(body),
      )
    ).json();
  const command = async (q: Record<string, unknown>) =>
    json("restore", restoreToken, { ...q, jobId, generation });
  const job = async (q: Record<string, unknown>): Promise<Job | null> => {
    const r = (await command(q)) as Job | null;
    if (
      r !== null &&
      (r.jobId !== jobId ||
        r.generation !== generation ||
        !Number.isSafeInteger(r.previousRevision))
    )
      throw Error("Conversation restore ownership differs");
    return r;
  };
  return {
    job,
    async revision() {
      const p = (await json("status", token)) as {
        generation: string;
        revision: number;
        mode: string;
      };
      if (
        p.generation !== generation ||
        p.mode !== "remote" ||
        !Number.isSafeInteger(p.revision)
      )
        throw Error("Conversation placement changed before restore");
      return p.revision;
    },
    async prepare(
      directory: string,
      prepared: string,
      expectedRevision: number,
    ) {
      const file = join(prepared, "messages.db");
      if (!existsSync(file)) {
        const blank = new DatabaseSync(file);
        try {
          initializeMessageDatabase(blank);
        } finally {
          blank.close();
        }
      }
      const api = {
        admin: command,
        page: (q: Record<string, unknown>) => command({ ...q, op: "read" }),
        receiptBatch: (q: Record<string, unknown>) =>
          json("receipts-batch", token, { ...q, generation }),
        getReceipt: async (sha: string) =>
          (
            await call(
              "receipts/" + encodeURIComponent(generation) + "/" + sha,
              token,
            )
          ).body,
        putReceipt: async (sha: string, stream: ReadableStream) =>
          (
            await call(
              "receipts/" + encodeURIComponent(generation) + "/" + sha,
              token,
              stream,
              "PUT",
            )
          ).json(),
        importStream: async (
          q: Record<string, string>,
          stream: ReadableStream,
        ) => {
          const params = new URLSearchParams({
            generation,
            jobId,
            threadId: q.threadId,
            loadId: q.loadId,
            table: q.table,
          });
          return (
            await call("restore-row?" + params.toString(), restoreToken, stream)
          ).json();
        },
      };
      return stagePortableHistory(api, directory, prepared, {
        jobId,
        generation,
        expectedRevision,
      });
    },
  };
}
