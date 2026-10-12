
export type Json = Record<string, unknown>;

export interface HarnessClient {
  api(path: string, init?: RequestInit): Promise<Json>;
  apiResponse(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }>;
}

export function createHarnessClient(baseUrl: string, token: string): HarnessClient {
  async function api(path: string, init?: RequestInit): Promise<Json> {
    const { ok, status, body } = await apiResponse(path, init);
    if (!ok) throw new Error(String(body.error ?? `HTTP ${status}`));
    return body;
  }

  async function apiResponse(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
    const res = await fetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers },
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    return { ok: res.ok, status: res.status, body };
  }

  return { api, apiResponse };
}

export function harnessClientFromEnv(env: NodeJS.ProcessEnv): HarnessClient {
  return createHarnessClient(env.LATERDOG_HARNESS_URL ?? "http://127.0.0.1:8799", env.LATERDOG_COMMS_TOKEN ?? "");
}
