import { z } from "zod";
import { DATA_DIR } from "../config.ts";
import { fromLocalTools } from "../request-auth.ts";
import { pointerSummary, botPointers, readPointer } from "../laterdog/engine-pointer.ts";
import { engineOpener, type PlacementChange, type RemoteEngineChoice } from "../laterdog/engine-placement.ts";
import type { EngineLink } from "../laterdog/engine-remote.ts";
import { WorkspaceAccessError, bringWorkspaceHome, readOwnedWorkspaceFile } from "../laterdog/engine-workspace-access.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const ENGINE_PLACEMENT_PATH = /^\/api\/bots\/([\w-]+)\/engine-placement$/;
export const ENGINE_WORKSPACES_PATH = /^\/api\/bots\/([\w-]+)\/engine-workspaces(?:\/(file|home))?$/;

const placementSchema = z.object({ placement: z.enum(["computer", "home"]), workspace: z.enum(["computer", "home"]).optional() }).strict();
const homeSchema = z.object({ cwd: z.string().min(1).max(4096) }).strict();

export interface EngineWorkspaceAccess {
  dataDir: string;
  relay(botId: string): Promise<EngineLink>;
}

export interface EnginePlacementRouteDeps {
  botExists(botId: string): boolean;
  read(botId: string): RemoteEngineChoice;
  save(botId: string, change: boolean | PlacementChange): RemoteEngineChoice;
  workspaces?: EngineWorkspaceAccess;
}

const homeWorkspaces = (): EngineWorkspaceAccess => ({
  dataDir: DATA_DIR,
  relay: async (botId) => {
    const opener = engineOpener();
    if (!opener?.relay) throw new Error("This home cannot reach cloud computers.");
    return opener.relay(botId);
  },
});

const wire = (choice: RemoteEngineChoice) => ({
  botId: choice.botId,
  placement: choice.computer ? "computer" : "home",
  workspace: choice.workspaceOnComputer ? "computer" : "home",
  heldWorkspaces: choice.heldWorkspaces,
  fromEnvironment: choice.fromEnvironment,
  engines: ["claude"],
});

export function createEnginePlacementRoutes(deps: EnginePlacementRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    const placement = ENGINE_PLACEMENT_PATH.exec(path);
    const workspaces = placement ? null : ENGINE_WORKSPACES_PATH.exec(path);
    if (!placement && !workspaces) return PASS;
    const botId = (placement ?? workspaces)![1]!;
    if (!auth.scopes.includes("admin") || fromLocalTools(auth)) return json(res, 403, { error: "Only the owner can choose where a dog's engine and workspace live." });
    if (workspaces) return serveWorkspaces({ req, res, url, method, json, readBody, botId, action: workspaces[2] ?? "", deps });
    if (method !== "GET" && method !== "PUT") return json(res, 405, { error: "method_not_allowed" });
    if (!deps.botExists(botId)) return json(res, 404, { error: "no such bot" });
    if (method === "GET") return json(res, 200, wire(deps.read(botId)));
    const parsed = placementSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send placement: \"computer\" or \"home\", and optionally workspace: \"computer\" or \"home\"." });
    const current = deps.read(botId);
    if (current.fromEnvironment && parsed.data.placement === "home") {
      return json(res, 409, { error: "This dog's engine is placed on its computer by the home's environment, so it cannot be changed here." });
    }
    const leavesComputer = parsed.data.placement === "home" || parsed.data.workspace === "home";
    if (leavesComputer && current.heldWorkspaces > 0) {
      return json(res, 409, { error: `This dog has ${current.heldWorkspaces} workspace(s) living on its cloud computer. Bring them home first, then change where it works.` });
    }
    if (parsed.data.workspace === "computer" && parsed.data.placement !== "computer") {
      return json(res, 400, { error: "A workspace can live on the computer only while the engine runs there." });
    }
    try {
      const change: boolean | PlacementChange = parsed.data.workspace === undefined ? parsed.data.placement === "computer"
        : { computer: parsed.data.placement === "computer", workspaceOnComputer: parsed.data.workspace === "computer" };
      return json(res, 200, wire(deps.save(botId, change)));
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  };
}

interface WorkspaceRequest {
  req: Parameters<RouteHandler>[0]["req"];
  res: Parameters<RouteHandler>[0]["res"];
  url: URL;
  method: string;
  json: Parameters<RouteHandler>[0]["json"];
  readBody: Parameters<RouteHandler>[0]["readBody"];
  botId: string;
  action: string;
  deps: EnginePlacementRouteDeps;
}

async function serveWorkspaces({ req, res, url, method, json, readBody, botId, action, deps }: WorkspaceRequest): Promise<void> {
  if (!deps.botExists(botId)) return json(res, 404, { error: "no such bot" });
  const access = deps.workspaces ?? homeWorkspaces();
  const relay = () => access.relay(botId);
  try {
    if (action === "") {
      if (method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      return json(res, 200, { workspaces: botPointers(access.dataDir, botId).map(pointerSummary) });
    }
    if (action === "file") {
      if (method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      const cwd = url.searchParams.get("cwd") ?? "";
      const name = url.searchParams.get("path") ?? "";
      if (!cwd || !readPointer(access.dataDir, botId, cwd)) return json(res, 404, { error: "That workspace has no record of living on the dog's cloud computer." });
      const read = await readOwnedWorkspaceFile({ dataDir: access.dataDir, botId, cwd, path: name, relay });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-laterdog-workspace-source": read.source,
        "x-laterdog-workspace-hash": read.hash,
        "x-laterdog-workspace-matches-manifest": read.matchesManifest === null ? "unknown" : String(read.matchesManifest),
        ...(read.note ? { "x-laterdog-workspace-note": encodeURIComponent(read.note) } : {}),
      });
      res.end(read.bytes);
      return;
    }
    if (method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    const parsed = homeSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Send cwd: the workspace folder to bring home." });
    return json(res, 200, await bringWorkspaceHome({ dataDir: access.dataDir, botId, cwd: parsed.data.cwd, relay }));
  } catch (error) {
    const status = error instanceof WorkspaceAccessError ? error.status : 500;
    return json(res, status, { error: (error as Error).message });
  }
}
