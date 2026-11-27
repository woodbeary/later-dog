import { describe, expect, it } from "vitest";
import { boxRequest, boxRoute, profileKey, validDog } from "../src/box-routes";

describe("personal box routes", () => {
  it("reads the box, desktop, screenshot and viewer paths", () => {
    expect(boxRoute("GET", "/v1/box")).toEqual({ op: "view" });
    expect(boxRoute("POST", "/v1/box")).toEqual({ op: "start" });
    expect(boxRoute("DELETE", "/v1/box")).toEqual({ op: "stop" });
    expect(boxRoute("PUT", "/v1/box")).toEqual({ op: "method_not_allowed", allow: ["GET", "POST", "DELETE"] });
    expect(boxRoute("POST", "/v1/box/desktops/dog-1")).toEqual({ op: "open", dog: "dog-1" });
    expect(boxRoute("DELETE", "/v1/box/desktops/dog-1")).toEqual({ op: "close", dog: "dog-1" });
    expect(boxRoute("GET", "/v1/box/desktops/dog-1/screenshot")).toEqual({ op: "screenshot", dog: "dog-1" });
    expect(boxRoute("GET", "/v1/box/desktops/dog-1/viewer")).toEqual({ op: "viewer", dog: "dog-1" });
    expect(boxRoute("POST", "/v1/box/desktops/dog-1/input")).toEqual({ op: "input", dog: "dog-1" });
    expect(boxRoute("GET", "/v1/box/desktops/dog-1/input")).toEqual({ op: "method_not_allowed", allow: ["POST"] });
    expect(boxRoute("POST", "/v1/box/desktops/dog-1/save")).toEqual({ op: "save", dog: "dog-1" });
    expect(boxRoute("GET", "/v1/box/profiles")).toEqual({ op: "profiles" });
    expect(boxRoute("GET", "/v1/box/moves")).toEqual({ op: "inventory" });
    expect(boxRoute("POST", "/v1/box/moves/dog-1/from/cmp_abc")).toEqual({ op: "move", dog: "dog-1", computer: "cmp_abc" });
    expect(boxRoute("GET", "/v1/pool")).toBeUndefined();
  });

  it("accepts only plain dog ids", () => {
    expect(validDog("729b4947-cfec-4e50-aadb-994826aa47a3")).toBe(true);
    expect(validDog("../etc")).toBe(false);
    expect(validDog("")).toBe(false);
    expect(profileKey("registry", "dog-1")).toBe("box/registry/profiles/dog-1.tgz");
  });

  it("keeps the box out of the free trial and refuses odd dog ids before reaching the box", async () => {
    const never = { get() { throw new Error("box reached"); }, idFromName() { throw new Error("box reached"); } } as never;
    const place = { boxes: never, state: never };
    const owner = (trial: boolean) => ({ person: "registry", trial, computers: async () => [], computer: () => never });
    const trial = await boxRequest({ op: "view" }, new Request("https://x/v1/box"), place, owner(true));
    expect(trial.status).toBe(403);
    const odd = await boxRequest({ op: "open", dog: "a/b" }, new Request("https://x/v1/box/desktops/a"), place, owner(false));
    expect(odd.status).toBe(400);
  });
});
