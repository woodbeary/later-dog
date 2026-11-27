import { describe, expect, it } from "vitest";

import { createRecentlyDeletedRoutes, RECENTLY_DELETED_OWNER_ONLY } from "./recently-deleted.ts";
import { PASS } from "./table.ts";

const call = async (handler: ReturnType<typeof createRecentlyDeletedRoutes>, method: string, path: string, owner = true) => {
  let answer: { status: number; body: unknown } | null = null;
  const result = await handler({ req: {} as never, res: {} as never, path, method, auth: { kind: owner ? "owner" : "guest" } as never,
    json: (_res: unknown, status: number, body: unknown) => { answer = { status, body }; }, readBody: async () => ({}) } as never);
  return result === PASS ? PASS : answer;
};

describe("Recently deleted", () => {
  it("lists the dogs, restores one for the owner and refuses anyone else", async () => {
    let dogs = [{ id: "b", name: "Ledger", at: 1, purgeAt: 2 }];
    const handler = createRecentlyDeletedRoutes({
      mayRestore: (auth) => (auth as { kind: string }).kind === "owner",
      list: () => dogs,
      restore: (id) => { const found = dogs.some((dog) => dog.id === id); dogs = dogs.filter((dog) => dog.id !== id); return found; },
    });
    expect(await call(handler, "GET", "/api/recently-deleted")).toEqual({ status: 200, body: { dogs } });
    expect(await call(handler, "POST", "/api/recently-deleted/b/restore", false)).toEqual({ status: 403, body: { error: RECENTLY_DELETED_OWNER_ONLY } });
    expect(await call(handler, "POST", "/api/recently-deleted/b/restore")).toEqual({ status: 200, body: { dogs: [] } });
    expect(await call(handler, "POST", "/api/recently-deleted/b/restore")).toMatchObject({ status: 404 });
    expect(await call(handler, "GET", "/api/other")).toBe(PASS);
  });
});
