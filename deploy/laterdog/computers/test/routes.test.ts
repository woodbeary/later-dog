import { describe, expect, it } from "vitest";
import { route } from "../src/routes";

const ID = "cmp_abcdefghij23";
const TOKEN = "1800007200.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("API routes", () => {
  it("routes the collection", () => {
    expect(route("GET", "/v1/computers")).toEqual({ kind: "collection", op: "list" });
    expect(route("POST", "/v1/computers")).toEqual({ kind: "collection", op: "create" });
    expect(route("POST", "/v1/computers/")).toEqual({ kind: "collection", op: "create" });
    expect(route("DELETE", "/v1/computers")).toEqual({ kind: "method_not_allowed", allow: ["GET", "POST"] });
  });

  it("routes one computer and its actions", () => {
    const cases: Array<[string, string, string]> = [
      ["GET", "", "get"],
      ["PATCH", "", "rename"],
      ["DELETE", "", "delete"],
      ["POST", "/wake", "wake"],
      ["POST", "/sleep", "sleep"],
      ["POST", "/exec", "exec"],
      ["GET", "/files", "readFile"],
      ["PUT", "/files", "writeFile"],
      ["GET", "/screenshot", "screenshot"],
      ["POST", "/desktop", "desktop"],
    ];
    for (const [method, suffix, op] of cases) {
      expect(route(method, `/v1/computers/${ID}${suffix}`), `${method} ${suffix}`).toEqual({ kind: "computer", op, id: ID });
    }
  });

  it("names the allowed methods when the method is wrong", () => {
    expect(route("GET", `/v1/computers/${ID}/exec`)).toEqual({ kind: "method_not_allowed", allow: ["POST"] });
    expect(route("POST", `/v1/computers/${ID}`)).toEqual({ kind: "method_not_allowed", allow: ["GET", "PATCH", "DELETE"] });
    expect(route("DELETE", `/v1/computers/${ID}/files`)).toEqual({ kind: "method_not_allowed", allow: ["GET", "PUT"] });
  });

  it("does not find malformed ids, unknown actions or other API paths", () => {
    for (const path of [
      "/v1/computers/cmp_ABCDEFGHIJ23",
      "/v1/computers/abc",
      `/v1/computers/${ID}/reboot`,
      `/v1/computers/${ID}/constructor`,
      `/v1/computers/${ID}/__proto__`,
      `/v1/computers/${ID}/files/extra`,
      "/v1",
      "/v1/other",
    ]) {
      expect(route("GET", path), path).toEqual({ kind: "not_found", api: true });
    }
    expect(route("GET", "/")).toEqual({ kind: "not_found", api: false });
  });

  it("serves health checks", () => {
    expect(route("GET", "/healthz")).toEqual({ kind: "health" });
  });
});

describe("desktop routes", () => {
  const base = `/desktop/${ID}/${TOKEN}`;

  it("redirects the bare link to its trailing-slash form", () => {
    expect(route("GET", base)).toEqual({ kind: "redirect", location: `${base}/` });
  });

  it("reaches the page, status, socket and noVNC modules", () => {
    expect(route("GET", `${base}/`)).toEqual({ kind: "desktop", id: ID, token: TOKEN, resource: { type: "page" } });
    expect(route("GET", `${base}/status`)).toMatchObject({ resource: { type: "status" } });
    expect(route("GET", `${base}/websockify`)).toMatchObject({ resource: { type: "socket" } });
    expect(route("GET", `${base}/core/rfb.js`)).toMatchObject({ resource: { type: "asset", path: "core/rfb.js" } });
    expect(route("GET", `${base}/core/util/logging.js`)).toMatchObject({ resource: { type: "asset", path: "core/util/logging.js" } });
    expect(route("GET", `${base}/vendor/pako/lib/zlib/inflate.js`)).toMatchObject({ resource: { type: "asset", path: "vendor/pako/lib/zlib/inflate.js" } });
  });

  it("does not reach anything else in the container", () => {
    for (const rest of ["vnc.html", "app/ui.js", "core/", "core/../vnc.html", "core/%2e%2e/vnc.html", "core/.hidden.js", "defaults.json", "core/rfb.js/x", "status/x"]) {
      expect(route("GET", `${base}/${rest}`), rest).toEqual({ kind: "not_found", api: false });
    }
  });

  it("only answers GET", () => {
    expect(route("POST", `${base}/`)).toEqual({ kind: "method_not_allowed", allow: ["GET"] });
  });

  it("does not route malformed ids or tokens", () => {
    expect(route("GET", `/desktop/cmp_nope/${TOKEN}/`)).toEqual({ kind: "not_found", api: false });
    expect(route("GET", `/desktop/${ID}/bad%20token/`)).toEqual({ kind: "not_found", api: false });
    expect(route("GET", `/desktop/${ID}/${"a".repeat(129)}/`)).toEqual({ kind: "not_found", api: false });
  });
});
