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
): Promise<Response> {
  const dir = directory(env, stable);
  const write = historyOperationWrites(query.operation);
  const grant = await dir.open(
    query.generation,
    query.threadId,
    write ? "write" : "read",
  );
  return shard(env, stable, grant).execute(
    grant,
    grant.mode,
    query.operation,
    query.requestId,
  );
}

export class HistoryApi extends WorkerEntrypoint<HistoryEnvironment> {
  async handle(stable: string, request: Request): Promise<Response> {
    const url = new URL(request.url),
      dir = directory(this.env, stable);
    if (url.pathname === "/history/status" && request.method === "GET")
      return Response.json(await dir.status());
    if (url.pathname === "/history/threads" && request.method === "GET")
      return Response.json(
        await dir.list(
          url.searchParams.get("generation") ?? "",
          url.searchParams.get("after") ?? undefined,
        ),
      );
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (
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
      return execute(this.env, stable, await request.json<Query>());
    if (url.pathname !== "/history/many")
      return new Response(null, { status: 404 });
    const query = await request.json<Many>();
    const write = historyOperationWrites(query.operation);
    if (write && !query.requestId)
      throw Error("A fan-out history write requires a request ID");
    let threads: string[], next: string | null;
    if (query.threadIds) {
      if (!Array.isArray(query.threadIds)) throw Error("Invalid thread list");
      query.threadIds.forEach(requireThread);
      const ids = Array.from(new Set(query.threadIds))
        .sort()
        .filter((thread) => query.after == null || thread > query.after);
      threads = ids.slice(0, 12);
      next = ids.length > threads.length ? threads.at(-1)! : null;
    } else
      ({ threads, next } = await dir.list(query.generation, query.after, 12));
    const items = await Promise.all(
      threads.map(async (threadId) => {
        const reply = await execute(this.env, stable, {
          generation: query.generation,
          threadId,
          operation: query.operation,
          requestId: query.requestId,
        });
        const { result } = await reply.json<{ result: unknown }>();
        return { threadId, result };
      }),
    );
    return Response.json({ items, next });
  }
}

type Admin =
  | { op: "status" }
  | {
      op: "begin" | "hold" | "abandon";
      generation: string;
      expectedRevision: number;
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
  | { op: "watermark" | "shardStatus"; generation: string; threadId: string }
  | ((PageCommand | ImportCommand) & { generation: string; threadId: string });

export class HistoryMigrationApi extends WorkerEntrypoint<HistoryEnvironment> {
  async admin(stable: string, req: Admin) {
    const dir = directory(this.env, stable);
    switch (req.op) {
      case "status":
        return dir.status();
      case "abandon":
        return dir.abandon(req.generation, req.expectedRevision);
      case "begin":
        return dir.begin(req.generation, req.expectedRevision);
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
            const proof = await shard(this.env, stable, grant).fence(grant);
            await dir.fenced(req.generation, thread, req.revision, proof);
          }),
        );
        return page;
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
    return shard(this.env, stable, grant).pageStream(grant, {
      ...req,
      op: "page",
    });
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
