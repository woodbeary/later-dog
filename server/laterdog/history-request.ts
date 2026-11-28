export async function historyRequest<T>(url: string, token: string, route: string, body: unknown): Promise<T> {
  const receipt = route.startsWith("receipts/");
  if (receipt && body !== undefined && typeof body !== "string") throw Error("Invalid conversation receipt");
  const payload = body === undefined ? undefined : receipt ? (body as string) : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url + "/" + route, {
        method: payload === undefined ? "GET" : receipt ? "PUT" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": receipt ? "application/octet-stream" : "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok && receipt) {
        if (payload !== undefined) {
          await response.body?.cancel();
          return null as T;
        }
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer()) as T;
      }
      if (response.ok) return (await response.json()) as T;
      await response.body?.cancel();
      if (response.status >= 500 && attempt === 0) continue;
      throw new HistoryHttpError("History " + route.split("?")[0] + " returned " + response.status);
    } catch (error) {
      if (attempt !== 0 || error instanceof HistoryHttpError) throw error;
    }
  }
}
class HistoryHttpError extends Error {}
