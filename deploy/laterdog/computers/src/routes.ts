import { isComputerId } from "./ids";

export type CollectionOp = "list" | "create";
export type TrialOp = "status" | "end";
export type ComputerOp = "get" | "rename" | "delete" | "wake" | "sleep" | "reset" | "update" | "exec" | "process" | "readFile" | "writeFile" | "screenshot" | "desktop";

export type TaskLineOp = "line" | "settings" | "save_settings" | "take" | "ticket" | "drop";

export type PoolOp = "view" | "start" | "stop" | "open" | "close" | "stream";

export type DesktopResource = { type: "page" } | { type: "status" } | { type: "socket" };

export type Route =
  | { kind: "health" }
  | { kind: "collection"; op: CollectionOp }
  | { kind: "environments"; op: "list" | "prepare" }
  | { kind: "task_line"; op: TaskLineOp; id?: string }
  | { kind: "pool"; op: PoolOp; chat?: string }
  | { kind: "computer"; op: ComputerOp; id: string }
  | { kind: "desktop"; id: string; token: string; resource: DesktopResource }
  | { kind: "redirect"; location: string }
  | { kind: "trial_page" }
  | { kind: "trial"; op: TrialOp }
  | { kind: "trial_offer" }
  | { kind: "trial_grant" }
  | { kind: "home_grant" }
  | { kind: "trial_start" }
  | { kind: "decide" }
  | { kind: "mcp" }
  | { kind: "voices" }
  | { kind: "chat" | "chat_grant" }
  | { kind: "complete" }
  | { kind: "plan"; op: "status" | "checkout" | "cancel" }
  | { kind: "plan_done" }
  | { kind: "speak"; voiceId: string }
  | { kind: "transcribe" }
  | { kind: "usage" }
  | { kind: "usage_owner" }
  | { kind: "usage_grants" }
  | { kind: "not_found"; api: boolean }
  | { kind: "method_not_allowed"; allow: string[] };

const COLLECTION: Record<string, CollectionOp> = { GET: "list", POST: "create" };
const TRIAL: Record<string, TrialOp> = { GET: "status", DELETE: "end" };

const ACTIONS: Record<string, Record<string, ComputerOp>> = {
  "": { GET: "get", PATCH: "rename", DELETE: "delete" },
  wake: { POST: "wake" },
  sleep: { POST: "sleep" },
  reset: { POST: "reset" },
  update: { POST: "update" },
  exec: { POST: "exec" },
  process: { GET: "process" },
  files: { GET: "readFile", PUT: "writeFile" },
  screenshot: { GET: "screenshot" },
  desktop: { POST: "desktop" },
};

const TICKET_PATH = /^\/v1\/task-line\/tickets\/(tkt_[a-z2-7]{16})$/;

function taskLineRoute(method: string, pathname: string): Route | undefined {
  if (pathname === "/v1/task-line") return method === "GET" ? { kind: "task_line", op: "line" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/task-line/settings") {
    const op = method === "GET" ? "settings" : method === "PUT" ? "save_settings" : undefined;
    return op ? { kind: "task_line", op } : { kind: "method_not_allowed", allow: ["GET", "PUT"] };
  }
  if (pathname === "/v1/task-line/tickets") return method === "POST" ? { kind: "task_line", op: "take" } : { kind: "method_not_allowed", allow: ["POST"] };
  const ticket = TICKET_PATH.exec(pathname);
  if (ticket) {
    const op = method === "GET" ? "ticket" : method === "DELETE" ? "drop" : undefined;
    return op ? { kind: "task_line", op, id: ticket[1]! } : { kind: "method_not_allowed", allow: ["GET", "DELETE"] };
  }
  return undefined;
}

const POOL_ENGINE_PATH = /^\/v1\/pool\/engines\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,95})(\/stream)?$/;
const POOL_ROOT: Record<string, PoolOp> = { GET: "view", POST: "start", DELETE: "stop" };

function poolRoute(method: string, pathname: string): Route | undefined {
  if (pathname === "/v1/pool") {
    const op = POOL_ROOT[method];
    return op ? { kind: "pool", op } : { kind: "method_not_allowed", allow: Object.keys(POOL_ROOT) };
  }
  if (pathname === "/v1/pool/engines") return method === "POST" ? { kind: "pool", op: "open" } : { kind: "method_not_allowed", allow: ["POST"] };
  const engine = POOL_ENGINE_PATH.exec(pathname);
  if (!engine) return undefined;
  if (engine[2]) return method === "GET" ? { kind: "pool", op: "stream", chat: engine[1]! } : { kind: "method_not_allowed", allow: ["GET"] };
  return method === "DELETE" ? { kind: "pool", op: "close", chat: engine[1]! } : { kind: "method_not_allowed", allow: ["DELETE"] };
}

const API_PATH = /^\/v1\/computers(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/;
const DESKTOP_PATH = /^\/desktop\/([^/]+)\/([^/]+)(\/.*)?$/;
const VOICE_PATH = /^\/v1\/voice\/text-to-speech\/([A-Za-z0-9]{1,64})$/;
const DESKTOP_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

function allow(table: Record<string, string>, method: string): string | undefined {
  return Object.hasOwn(table, method) ? table[method] : undefined;
}

export function route(method: string, pathname: string): Route {
  if (pathname === "/healthz") return method === "GET" ? { kind: "health" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/trial") return method === "GET" || method === "POST" ? { kind: "trial_page" } : { kind: "method_not_allowed", allow: ["GET", "POST"] };
  if (pathname === "/v1/trials") return method === "GET" ? { kind: "trial_offer" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/trials/grant") return method === "POST" ? { kind: "trial_grant" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/homes/grant") return method === "POST" ? { kind: "home_grant" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/trials/start") return method === "POST" ? { kind: "trial_start" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/systemone") return method === "POST" ? { kind: "decide" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/mcp" || pathname === "/mcp/") return method === "POST" ? { kind: "mcp" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/voice/voices") return method === "GET" ? { kind: "voices" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/voice/speech-to-text") return method === "POST" ? { kind: "transcribe" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/complete") return method === "POST" ? { kind: "complete" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/ai/grant") return method === "POST" ? { kind: "chat_grant" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/ai/chat/completions") return method === "POST" ? { kind: "chat" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/plan") {
    const op = method === "GET" ? "status" : method === "DELETE" ? "cancel" : undefined;
    return op ? { kind: "plan", op } : { kind: "method_not_allowed", allow: ["GET", "DELETE"] };
  }
  if (pathname === "/v1/plan/checkout") return method === "POST" ? { kind: "plan", op: "checkout" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/plan/done") return method === "GET" ? { kind: "plan_done" } : { kind: "method_not_allowed", allow: ["GET"] };
  const speak = VOICE_PATH.exec(pathname);
  if (speak) return method === "POST" ? { kind: "speak", voiceId: speak[1]! } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/usage") return method === "GET" ? { kind: "usage" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/usage/owner") return method === "GET" ? { kind: "usage_owner" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/usage/owner/grants") return method === "PUT" ? { kind: "usage_grants" } : { kind: "method_not_allowed", allow: ["PUT"] };
  if (pathname === "/v1/environments") {
    const op = method === "GET" ? "list" : method === "POST" ? "prepare" : undefined;
    return op ? { kind: "environments", op } : { kind: "method_not_allowed", allow: ["GET", "POST"] };
  }
  if (pathname.startsWith("/v1/pool")) {
    const found = poolRoute(method, pathname);
    if (found) return found;
  }
  if (pathname.startsWith("/v1/task-line")) {
    const found = taskLineRoute(method, pathname);
    if (found) return found;
  }
  if (pathname === "/v1/trial") {
    const op = allow(TRIAL, method) as TrialOp | undefined;
    return op ? { kind: "trial", op } : { kind: "method_not_allowed", allow: Object.keys(TRIAL) };
  }

  const api = API_PATH.exec(pathname);
  if (api) {
    const [, id, action] = api;
    if (id === undefined) {
      const op = allow(COLLECTION, method) as CollectionOp | undefined;
      return op ? { kind: "collection", op } : { kind: "method_not_allowed", allow: Object.keys(COLLECTION) };
    }
    const key = action ?? "";
    const table = Object.hasOwn(ACTIONS, key) ? ACTIONS[key] : undefined;
    if (!isComputerId(id) || !table) return { kind: "not_found", api: true };
    const op = allow(table, method) as ComputerOp | undefined;
    return op ? { kind: "computer", op, id } : { kind: "method_not_allowed", allow: Object.keys(table) };
  }
  if (pathname.startsWith("/v1/") || pathname === "/v1") return { kind: "not_found", api: true };

  const desktop = DESKTOP_PATH.exec(pathname);
  if (desktop) {
    const [, id, token, tail] = desktop;
    if (!isComputerId(id!) || !DESKTOP_TOKEN.test(token!)) return { kind: "not_found", api: false };
    if (tail === undefined) return { kind: "redirect", location: `/desktop/${id}/${token}/` };
    if (method !== "GET") return { kind: "method_not_allowed", allow: ["GET"] };
    const rest = tail.slice(1);
    let resource: DesktopResource | undefined;
    if (rest === "") resource = { type: "page" };
    else if (rest === "status") resource = { type: "status" };
    else if (rest === "websockify") resource = { type: "socket" };
    return resource ? { kind: "desktop", id: id!, token: token!, resource } : { kind: "not_found", api: false };
  }
  return { kind: "not_found", api: false };
}
