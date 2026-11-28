import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { commsTokenFromEnv } from "../laterdog/comms-token-file.ts";

export type Json = Record<string, unknown>;

export interface HarnessClient {
  api(path: string, init?: RequestInit): Promise<Json>;
  apiResponse(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }>;
  apiWait?(path: string, body: string, waitMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: Json }>;
}

export function postAndWait(url: string, token: string, body: string, waitMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("The call was cancelled before it started."));
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(target, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        signal?.removeEventListener("abort", cancel);
        let parsed: Json = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json; } catch { parsed = {}; }
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, body: parsed });
      });
    });
    const cancel = () => req.destroy(new Error("The call was cancelled."));
    signal?.addEventListener("abort", cancel, { once: true });
    req.setTimeout(waitMs, () => req.destroy(new Error(`No answer within ${Math.round(waitMs / 60_000)} minutes.`)));
    req.on("error", (error) => { signal?.removeEventListener("abort", cancel); reject(error); });
    req.end(body);
  });
}

export function createHarnessClient(baseUrl: string, tokenSource: string | (() => string)): HarnessClient {
  const token = typeof tokenSource === "string" ? () => tokenSource : tokenSource;
  async function api(path: string, init?: RequestInit): Promise<Json> {
    const { ok, status, body } = await apiResponse(path, init);
    if (!ok) throw new Error(String(body.error ?? `HTTP ${status}`));
    return body;
  }

  async function apiResponse(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
    const res = await fetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok, status: res.status, body };
  }

  const apiWait = (path: string, body: string, waitMs: number, signal?: AbortSignal) => postAndWait(baseUrl + path, token(), body, waitMs, signal);

  return { api, apiResponse, apiWait };
}

export function harnessClientFromEnv(env: NodeJS.ProcessEnv): HarnessClient {
  return createHarnessClient(env.LATERDOG_HARNESS_URL ?? "http://127.0.0.1:8799", commsTokenFromEnv(env));
}
