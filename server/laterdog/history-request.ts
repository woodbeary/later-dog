export async function historyRequest<T>(url: string, token: string, route: string, body: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url + "/" + route, {
        method: payload === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(25_000),
      });
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
