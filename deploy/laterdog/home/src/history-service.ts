import type { ReceiptPack } from "./history-receipt-packs.ts";
import type { ReceiptBatch } from "./history-receipts.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  historyOperationWrites,
  type HistoryOperation,
} from "../../../../shared/history-shard-operations.ts";
import type { HistoryTable } from "../../../../shared/history-migration.ts";
import { HistoryDirectory } from "./history-directory.ts";
import { HistoryShard } from "./history-shard.ts";
import {
  requireTenant,
  requireThread,
  shardName,
  type ImportCommand,
  type PageCommand,
  type ShardAddress,
} from "./history-routing.ts";

export { HistoryDirectory, HistoryShard };
interface HistoryEnvironment {
  RECEIPTS: R2Bucket;
  DIRECTORY: DurableObjectNamespace<HistoryDirectory>;
  THREADS: DurableObjectNamespace<HistoryShard>;
}
const directory = (env: HistoryEnvironment, stable: string) => {
  requireTenant(stable);
  return env.DIRECTORY.getByName(stable);
};
const shard = (env: HistoryEnvironment, stable: string, grant: ShardAddress) =>
  env.THREADS.getByName(shardName(stable, grant.generation, grant.threadId));

interface Query {
  generation: string;
  threadId: string;
  operation: HistoryOperation;
  requestId?: string;
}
interface Many {
  generation: string;
  threadIds?: string[];
  operation: HistoryOperation;
  after?: string;
  requestId?: string;
}
async function execute(
  env: HistoryEnvironment,
  stable: string,
  query: Query,
  background: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const dir = directory(env, stable);
  const write = historyOperationWrites(query.operation);
  const reports = write && query.operation.op !== "messages.leaf";
  const token = reports ? crypto.randomUUID() : null;
  const grant = await dir.open(
    query.generation,
    query.threadId,
    write ? "write" : "read",
    token,
  );
  const response = await shard(env, stable, grant).execute(
    grant,
    grant.mode,
    query.operation,
    query.requestId,
    reports,
  );
  if (token) {
    const raw = response.headers.get("x-history-recovery");
    if (raw)
      background(
        dir.recoverySettled(
          grant.generation,
          grant.threadId,
          token,
          JSON.parse(raw),
        ),
      );
  }
  return response;
}

type RestoreRequest = { jobId: string; generation: string } & (
  | { op: "status" | "finish" | "undo" }
  | { op: "begin"; expectedRevision: number; eventSequence?: string }
  | { op: "switch"; proofs: [string, string][] }
  | ({ threadId: string } & (
      | ImportCommand
      | (Omit<PageCommand, "op"> & { op: "read" })
    ))
);
export class HistoryApi extends WorkerEntrypoint<HistoryEnvironment> {
  async eraseHome(stable: string, removalId: string) {
    return directory(this.env, stable).eraseHome(stable, removalId);
  }
  async reopenHome(stable: string, removalId: string) {
    return directory(this.env, stable).reopenHome(stable, removalId);
  }
  async neverActivated(stable: string, generation: string) {
    return directory(this.env, stable).neverActivated(generation);
  }
  async restore(stable: string, request: Request): Promise<Response> {
    const dir = directory(this.env, stable),
      url = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (url.pathname === "/history/restore-row") {
      const value = (key: string) => url.searchParams.get(key) ?? "";
      const key = { generation: value("generation"), jobId: value("jobId") };
      const grant = await dir.restoreAddress(key, value("threadId"), "stage");
      if (!request.body) throw Error("No history restore row");
      return Response.json(
        await shard(this.env, stable, grant).importStream(
          grant,
          { loadId: value("loadId"), table: value("table") as HistoryTable },
          request.body,
        ),
      );
    }
    if (url.pathname !== "/history/restore")
      return new Response(null, { status: 404 });
    const req = await request.json<RestoreRequest>(),
      key = { jobId: req.jobId, generation: req.generation };
    switch (req.op) {
      case "status":
        return Response.json(await dir.restoreStatus(key));
      case "begin":
        return Response.json(
          await dir.restoreBegin(key, req.expectedRevision, req.eventSequence),
        );
      case "undo":
      case "finish":
        return Response.json(await dir.restoreClose(key, req.op));
      case "reset":
      case "import":
      case "seal":
      case "read": {
        const grant = await dir.restoreAddress(key, req.threadId, "stage"),
          stub = shard(this.env, stable, grant);
        if (req.op === "read")
          return new Response(
            await stub.pageStream(grant, { ...req, op: "page" }),
            { headers: { "content-type": "application/json" } },
          );
        const result = await stub.importRows(grant, req);
        if (req.op !== "import")
          await dir.restoreRecord(
            key,
            req.threadId,
            result.sha256 ?? null,
            result.maximum,
          );
        return Response.json(result);
      }
      case "switch": {
        const job = await dir.restoreFreeze(key, req.proofs);
        if (job.status !== "fencing") return Response.json(job);
        const stageFence = async (side: "previous" | "target") => {
          const page = await dir.restorePage(key, side);
          await Promise.all(
            page.threads.map(async (thread) => {
              const grant = await dir.restoreAddress(
                key,
                thread,
                side,
                job.previousRevision + 1,
              );
              const { proof, recovery } = await shard(
                this.env,
                stable,
                grant,
              ).fenceForRecovery(grant);
              await dir.restoreFenced(key, grant, proof, recovery);
            }),
          );
          return page.next !== null;
        };
        const [previousPending, targetPending] = await Promise.all([
          stageFence("previous"),
          stageFence("target"),
        ]);
        if (previousPending || targetPending) return Response.json(job);
        return Response.json(await dir.restoreSwitch(key));
      }
    }
  }
  async handle(stable: string, request: Request): Promise<Response> {
    const url = new URL(request.url),
      dir = directory(this.env, stable);
    const receipt =
      /^\/history\/receipts\/([A-Za-z0-9_-]+)\/([0-9a-f]{64})$/.exec(
        url.pathname,
      );
    if (receipt || url.pathname === "/history/receipts-batch") {
      const placement = await dir.status();
      if (receipt) {
        if (placement.generation !== receipt[1] || placement.mode !== "remote")
          return new Response("History placement changed", { status: 409 });
        if (request.method === "GET")
          return new Response(
            await dir.readReceipt(stable, receipt[1], receipt[2], false),
          );
        if (request.method !== "PUT" || !request.body)
          return new Response(null, { status: 405 });
        try {
          return Response.json(
            await dir.writeReceipt(
              stable,
              receipt[1],
              receipt[2],
              request.body,
              false,
            ),
            { status: 201 },
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "History receipt checksum mismatch"
          )
            return new Response(error.message, { status: 422 });
          throw error;
        }
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const batch = await request.json<ReceiptBatch>();
      if (
        placement.generation !== batch.generation ||
        placement.mode !== "remote"
      )
        return new Response("History placement changed", { status: 409 });
      return Response.json(await dir.receipts(stable, batch, false));
    }
    if (url.pathname === "/history/status" && request.method === "GET")
      return Response.json(await dir.status());
    if (url.pathname === "/history/threads" && request.method === "GET") {
      const raw = url.searchParams.get("limit");
      const limit = raw === null ? 32 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) return new Response("Invalid history page size", { status: 400 });
      return Response.json(await dir.list(url.searchParams.get("generation") ?? "", url.searchParams.get("after") ?? undefined,limit));
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (
      url.pathname === "/history/export-commands" ||
      url.pathname === "/history/export-check" ||
      url.pathname === "/history/export-page"
    ) {
      const p = await dir.status();
      const req = await request.json<{
        generation: string;
        revision: number;
        threadIds?: string[];
        threadId: string;
        version: number;
        table: HistoryTable;
        after?: string;
        limit?: number;
      }>();
      if (
        p.mode !== "remote" ||
        p.generation !== req.generation ||
        p.revision !== req.revision
      )
        return new Response("History changed during export", { status: 409 });
      if (url.pathname === "/history/export-commands") {
        const grant = await dir.open(req.generation, req.threadId, "read");
        if (!grant.ordinal || grant.revision !== req.revision)
          throw Error("Command export membership changed");
        return Response.json(
          await shard(this.env, stable, grant).commands(
            grant,
            req.version,
            req.after,
            req.limit,
          ),
        );
      }
      if (url.pathname === "/history/export-page") {
        const grant = await dir.open(req.generation, req.threadId, "read");
        if (!grant.ordinal || grant.revision !== req.revision)
          throw Error("Export membership changed");
        return new Response(
          await shard(this.env, stable, grant).exportPage(grant, req.version, {
            op: "page",
            table: req.table,
            after: req.after,
            limit: req.limit,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (!Array.isArray(req.threadIds) || req.threadIds.length > 32)
        return new Response("Invalid export batch", { status: 400 });
      const items = await Promise.all(
        req.threadIds.map(async (thread) => {
          const grant = await dir.open(req.generation, thread, "read");
          if (!grant.ordinal || grant.revision !== req.revision)
            throw Error("Export membership changed");
          return shard(this.env, stable, grant).exportCheck(grant);
        }),
      );
      return Response.json({ items });
    }
    if (url.pathname === "/history/execute")
      return execute(this.env, stable, await request.json<Query>(), (promise) =>
        this.ctx.waitUntil(promise),
      );
    if (url.pathname !== "/history/many")
      return new Response(null, { status: 404 });
    const query = await request.json<Many>();
    const write = historyOperationWrites(query.operation);
    if (write && !query.requestId)
      throw Error("A fan-out history write requires a request ID");
    const pageSize = [
      "messages.latest",
      "messages.pending",
      "messages.references",
      "messages.recallStats",
      "native.recover",
      "native.prune",
    ].includes(query.operation.op)
      ? 64
      : 12;
    let threads: string[], next: string | null;
    const recorded = new Map<string, unknown>();
    if (query.threadIds) {
      if (!Array.isArray(query.threadIds)) throw Error("Invalid thread list");
      query.threadIds.forEach(requireThread);
      const ids = Array.from(new Set(query.threadIds))
        .sort()
        .filter((thread) => query.after == null || thread > query.after);
      threads = ids.slice(0, pageSize);
      next = ids.length > threads.length ? threads.at(-1)! : null;
    } else if (
      query.operation.op === "native.recover" ||
      query.operation.op === "messages.commandHead" ||
      query.operation.op === "messages.hasCards" ||
      query.operation.op === "messages.startupFacts"
    ) {
      const page = await dir.recoveryPage(
        query.generation,
        query.operation.op,
        query.after,
        query.operation.op === "native.recover" ? pageSize : 128,
      );
      threads = page.rows.map((row) => row.thread);
      next = page.next;
      if (query.operation.op === "messages.commandHead")
        for (const row of page.rows)
          if (!row.uncertain) recorded.set(row.thread, row.head);
      if (query.operation.op === "messages.hasCards")
        for (const row of page.rows)
          if (!row.uncertain && row.cards !== null)
            recorded.set(row.thread, !!row.cards);
      if (query.operation.op === "messages.startupFacts")
        for (const row of page.rows)
          if (!row.uncertain && row.facts !== null)
            recorded.set(row.thread, {
              waiting: !!(row.facts & 1),
              permission: !!(row.facts & 2),
              countdown: !!(row.facts & 4),
            });
    } else
      ({ threads, next } = await dir.list(
        query.generation,
        query.after,
        pageSize,
      ));
    const items: { threadId: string; result: unknown }[] = [];
    for (let start = 0; start < threads.length; start += 8) {
      const batch = await Promise.all(
        threads.slice(start, start + 8).map(async (threadId) => {
          if (recorded.has(threadId))
            return { threadId, result: recorded.get(threadId) };
          const reply = await execute(
            this.env,
            stable,
            {
              generation: query.generation,
              threadId,
              operation: query.operation,
              requestId: query.requestId,
            },
            (promise) => this.ctx.waitUntil(promise),
          );
          const { result } = await reply.json<{ result: unknown }>();
          return { threadId, result };
        }),
      );
      items.push(...batch);
    }
    return Response.json({ items, next });
  }
}

type Admin =
  | { op: "status" }
  | {
      op: "begin" | "hold" | "abandon";
      generation: string;
      expectedRevision: number;
      eventSequence?: string;
    }
  | { op: "list"; generation: string; after?: string }
  | { op: "barrier"; generation: string; revision: number }
  | { op: "fenceAll"; generation: string; revision: number; after?: string }
  | {
      op: "finish";
      generation: string;
      revision: number;
      mode: "remote" | "legacy";
      proofs: [string, string][];
    }
  | {
      op: "commands";
      generation: string;
      threadId: string;
      after?: string;
      limit?: number;
    }
  | { op: "watermark" | "shardStatus"; generation: string; threadId: string }
  | ((PageCommand | ImportCommand) & { generation: string; threadId: string });

export class HistoryMigrationApi extends WorkerEntrypoint<HistoryEnvironment> {
  putReceiptPack(
    stable: string,
    generation: string,
    pack: ReceiptPack,
    body: ReadableStream<Uint8Array>,
  ) {
    return directory(this.env, stable).putReceiptPack(
      stable,
      generation,
      pack,
      body,
    );
  }
  async getReceipt(stable: string, generation: string, sha: string) {
    return localStream(
      await directory(this.env, stable).readReceipt(
        stable,
        generation,
        sha,
        true,
      ),
    );
  }
  async putReceipt(
    stable: string,
    generation: string,
    sha: string,
    body: ReadableStream<Uint8Array>,
  ) {
    return directory(this.env, stable).writeReceipt(
      stable,
      generation,
      sha,
      body,
      true,
    );
  }
  async receiptBatch(
    stable: string,
    generation: string,
    req: Omit<ReceiptBatch, "generation">,
  ) {
    return directory(this.env, stable).receipts(
      stable,
      { ...req, generation },
      true,
    );
  }
  async admin(stable: string, req: Admin) {
    const dir = directory(this.env, stable);
    switch (req.op) {
      case "status":
        return dir.status();
      case "abandon":
        return dir.abandon(req.generation, req.expectedRevision);
      case "begin":
        return dir.begin(
          req.generation,
          req.expectedRevision,
          req.eventSequence,
        );
      case "hold":
        return dir.hold(req.generation, req.expectedRevision);
      case "barrier":
        return dir.barrier(req.generation, req.revision);
      case "finish":
        return dir.finish(req.generation, req.revision, req.mode, req.proofs);
      case "list":
        return dir.list(req.generation, req.after);
      case "fenceAll": {
        await dir.barrier(req.generation, req.revision);
        const page = await dir.list(req.generation, req.after, 16);
        await Promise.all(
          page.threads.map(async (thread) => {
            const grant = await dir.open(req.generation, thread, "export");
            if (grant.revision !== req.revision)
              throw Error("History fence changed");
            const { proof, recovery } = await shard(
              this.env,
              stable,
              grant,
            ).fenceForRecovery(grant);
            await dir.fenced(
              req.generation,
              thread,
              req.revision,
              proof,
              recovery,
            );
          }),
        );
        return page;
      }
      case "commands": {
        const p = await dir.status();
        if (p.mode !== "held" || p.generation !== req.generation)
          throw Error("A history fence is required to export command receipts");
        const grant = await dir.open(req.generation, req.threadId, "export");
        if (grant.revision !== p.revision) throw Error("History fence changed");
        return shard(this.env, stable, grant).commands(
          grant,
          null,
          req.after,
          req.limit,
        );
      }
      case "shardStatus":
      case "watermark":
      case "page": {
        const grant = await dir.open(req.generation, req.threadId, "export");
        const stub = shard(this.env, stable, grant);
        if (req.op === "shardStatus") return stub.shardStatus(grant);
        return req.op === "page"
          ? stub.page(grant, req)
          : stub.watermark(grant);
      }
      case "reset":
      case "import":
      case "seal": {
        const grant = await dir.open(req.generation, req.threadId, "stage");
        const result = await shard(this.env, stable, grant).importRows(
          grant,
          req,
        );
        if (req.op === "seal" || req.op === "reset")
          await dir.recordProof(
            req.generation,
            req.threadId,
            grant.revision,
            result.sha256 ?? null,
            result.maximum,
          );
        return result;
      }
      default:
        throw Error("Unknown history migration operation");
    }
  }
  async importStream(
    stable: string,
    req: {
      generation: string;
      threadId: string;
      loadId: string;
      table: HistoryTable;
    },
    body: ReadableStream<Uint8Array>,
  ) {
    const grant = await directory(this.env, stable).open(
      req.generation,
      req.threadId,
      "stage",
    );
    return shard(this.env, stable, grant).importStream(grant, req, body);
  }
  async pageStream(
    stable: string,
    req: Omit<PageCommand, "op"> & { generation: string; threadId: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const grant = await directory(this.env, stable).open(
      req.generation,
      req.threadId,
      "export",
    );
    return localStream(
      await shard(this.env, stable, grant).pageStream(grant, {
        ...req,
        op: "page",
      }),
    );
  }
}

async function localStream(body: ReadableStream<Uint8Array>) {
  return new Blob([await new Response(body).arrayBuffer()]).stream();
}

export default { fetch: () => new Response(null, { status: 404 }) };
