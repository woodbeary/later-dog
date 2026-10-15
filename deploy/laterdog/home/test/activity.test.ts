import { describe, expect, it } from "vitest";
import { parseActivity, signedActivityRequest } from "../src/activity.ts";

const NOW = 1_800_000_000_000;

describe("a home's answer about its work", () => {
  it("trusts only a well-formed answer", () => {
    expect(parseActivity({ busy: false, nextAt: NOW, work: [] })).toEqual({ busy: false, nextAt: NOW, work: [] });
    expect(parseActivity({ busy: "no", nextAt: null })).toBeNull();
    expect(parseActivity({ busy: false, nextAt: -1 })).toBeNull();
    expect(parseActivity(null)).toBeNull();
  });

  it("keeps the names of the work going, and reads an older home's answer as naming none", () => {
    expect(parseActivity({ busy: true, nextAt: null, work: ["turn", "cloud_job"] })).toEqual({ busy: true, nextAt: null, work: ["turn", "cloud_job"] });
    expect(parseActivity({ busy: true, nextAt: null })).toEqual({ busy: true, nextAt: null, work: [] });
    expect(parseActivity({ busy: true, nextAt: null, work: ["turn", "<script>", 7, "x".repeat(40)] })?.work).toEqual(["turn"]);
    expect(parseActivity({ busy: true, nextAt: null, work: Array.from({ length: 30 }, () => "turn") })?.work).toHaveLength(10);
  });

  it("asks with a signed GET", async () => {
    const request = await signedActivityRequest("https://h1-home.later.dog", "secret", NOW);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/cloud/activity");
    expect(request.headers.get("x-laterdog-cloud-signature")).toMatch(/^v1=[A-Za-z0-9_-]{43}$/);
    expect(request.headers.get("x-laterdog-cloud-timestamp")).toBe(String(Math.floor(NOW / 1000)));
  });
});
