import { isComputerId } from "./ids";

export type CollectionOp = "list" | "create";
export type TrialOp = "status" | "end";
export type ComputerOp = "get" | "rename" | "delete" | "wake" | "sleep" | "exec" | "readFile" | "writeFile" | "screenshot" | "desktop";

export type DesktopResource = { type: "page" } | { type: "status" } | { type: "socket" } | { type: "asset"; path: string };

export type Route =
  | { kind: "health" }
  | { kind: "collection"; op: CollectionOp }
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
  | { kind: "chat" }
  | { kind: "plan"; op: "status" | "checkout" | "cancel" }
  | { kind: "plan_done" }
  | { kind: "speak"; voiceId: string }
  | { kind: "transcribe" }
  | { kind: "not_found"; api: boolean }
  | { kind: "method_not_allowed"; allow: string[] };

const COLLECTION: Record<string, CollectionOp> = { GET: "list", POST: "create" };
const TRIAL: Record<string, TrialOp> = { GET: "status", DELETE: "end" };

const ACTIONS: Record<string, Record<string, ComputerOp>> = {
  "": { GET: "get", PATCH: "rename", DELETE: "delete" },
  wake: { POST: "wake" },
  sleep: { POST: "sleep" },
  exec: { POST: "exec" },
  files: { GET: "readFile", PUT: "writeFile" },
  screenshot: { GET: "screenshot" },
  desktop: { POST: "desktop" },
};

const API_PATH = /^\/v1\/computers(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/;
const DESKTOP_PATH = /^\/desktop\/([^/]+)\/([^/]+)(\/.*)?$/;
const VOICE_PATH = /^\/v1\/voice\/text-to-speech\/([A-Za-z0-9]{1,64})$/;
const DESKTOP_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const ASSET = /^(?:core|vendor)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\.js$/;

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
  if (pathname === "/mcp") return method === "POST" ? { kind: "mcp" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/voice/voices") return method === "GET" ? { kind: "voices" } : { kind: "method_not_allowed", allow: ["GET"] };
  if (pathname === "/v1/voice/speech-to-text") return method === "POST" ? { kind: "transcribe" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/ai/chat/completions") return method === "POST" ? { kind: "chat" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/v1/plan") {
    const op = method === "GET" ? "status" : method === "DELETE" ? "cancel" : undefined;
    return op ? { kind: "plan", op } : { kind: "method_not_allowed", allow: ["GET", "DELETE"] };
  }
  if (pathname === "/v1/plan/checkout") return method === "POST" ? { kind: "plan", op: "checkout" } : { kind: "method_not_allowed", allow: ["POST"] };
  if (pathname === "/plan/done") return method === "GET" ? { kind: "plan_done" } : { kind: "method_not_allowed", allow: ["GET"] };
  const speak = VOICE_PATH.exec(pathname);
  if (speak) return method === "POST" ? { kind: "speak", voiceId: speak[1]! } : { kind: "method_not_allowed", allow: ["POST"] };
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
    else if (ASSET.test(rest)) resource = { type: "asset", path: rest };
    return resource ? { kind: "desktop", id: id!, token: token!, resource } : { kind: "not_found", api: false };
  }
  return { kind: "not_found", api: false };
}
