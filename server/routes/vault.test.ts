import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { VaultStore } from "../laterdog/vault.ts";
import { requiredScope } from "../request-auth.ts";
import { dispatchRoutes } from "./table.ts";
import { createVaultRoutes } from "./vault.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(key: Buffer | null = Buffer.alloc(32, 3)) {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-vault-route-"));
  dirs.push(dir);
  const vault = new VaultStore(join(dir, "vault.json"), key);
  const routes = [createVaultRoutes({ vault })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, vault };
}

describe("vault routes", () => {
  it("are all for the owner only", () => {
    for (const [method, path] of [
      ["GET", "/api/vault"], ["GET", "/api/vault/offers"], ["POST", "/api/vault/logins"], ["PATCH", "/api/vault/logins/a-1"],
      ["DELETE", "/api/vault/logins/a-1"], ["POST", "/api/vault/import"], ["GET", "/api/vault/details"], ["PUT", "/api/vault/details"],
    ]) expect(requiredScope(method!, path!)).toBe("admin");
  });

  it("keeps the person's details and explains ones it can't", async () => {
    const { call } = await serve();
    expect(await call("GET", "/api/vault/details")).toEqual({ status: 200, body: { available: true, details: {} } });
    expect(await call("PUT", "/api/vault/details", { details: { name: "Kit Doe", tel: "555 0100", pet: "Rex" } })).toEqual({ status: 200, body: { details: { name: "Kit Doe", tel: "555 0100" } } });
    expect(await call("GET", "/api/vault/details")).toEqual({ status: 200, body: { available: true, details: { name: "Kit Doe", tel: "555 0100" } } });
    expect(await call("PUT", "/api/vault/details", { details: { email: "nope" } })).toEqual({ status: 400, body: { error: "That email address doesn't look right." } });
    const cloudOnly = await serve(null);
    expect(await cloudOnly.call("GET", "/api/vault/details")).toEqual({ status: 200, body: { available: false, details: {} } });
    expect(await cloudOnly.call("PUT", "/api/vault/details", { details: { name: "Kit" } })).toEqual({ status: 400, body: { error: "Saved logins are kept in later.dog Cloud." } });
  });

  it("adds, lists, edits and removes logins without ever answering with a password", async () => {
    const { call } = await serve();
    const added = await call("POST", "/api/vault/logins", { site: "accounts.google.com", username: "kit", password: "hunter2", note: "Main", extra: "ignored" });
    expect(added).toEqual({ status: 200, body: { replaced: false, login: expect.objectContaining({ site: "google.com", username: "kit", note: "Main" }) } });
    const { login } = added.body as { login: { id: string } };
    const id = login.id;
    expect(await call("GET", "/api/vault")).toEqual({ status: 200, body: { available: true, logins: [login] } });
    expect(await call("PATCH", `/api/vault/logins/${id}`, { password: "changed", note: "" })).toMatchObject({ status: 200, body: { login: { id, username: "kit" } } });
    expect(await call("GET", "/api/vault/offers?host=mail.google.com")).toMatchObject({ status: 200, body: { available: true, logins: [{ id }], lookalike: null } });
    expect(await call("GET", "/api/vault/offers?host=g00gle.com")).toEqual({ status: 200, body: { available: true, logins: [], lookalike: "google.com" } });
    expect(await call("DELETE", `/api/vault/logins/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect(await call("DELETE", `/api/vault/logins/${id}`)).toEqual({ status: 404, body: { error: "That login is no longer in your vault." } });
    expect(await call("PATCH", `/api/vault/logins/${id}`, { note: "x" })).toEqual({ status: 404, body: { error: "That login is no longer in your vault." } });
  });

  it("explains a login it cannot keep", async () => {
    const { call } = await serve();
    expect(await call("POST", "/api/vault/logins", { site: "localhost", username: "kit", password: "pw" }))
      .toEqual({ status: 400, body: { error: "Use the site's own address, for example example.com." } });
  });

  it("imports a password manager's export and says what it did", async () => {
    const { call } = await serve();
    const csv = "Title,Website,Username,Password,Notes\nGitHub,https://github.com,kit,pw,\nRouter,http://10.0.0.1,admin,admin,\n";
    expect(await call("POST", "/api/vault/import", { csv })).toEqual({ status: 200, body: { added: 1, updated: 0, skipped: 1, full: 0 } });
    expect(await call("POST", "/api/vault/import", { csv: "name\nkit\n" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("password export") } });
  });

  it("says the vault lives in later.dog Cloud on a home without a key", async () => {
    const { call } = await serve(null);
    expect(await call("GET", "/api/vault")).toEqual({ status: 200, body: { available: false, reason: "cloud-only", logins: [] } });
    expect(await call("POST", "/api/vault/logins", { site: "example.com", username: "kit", password: "pw" }))
      .toEqual({ status: 400, body: { error: "Saved logins are kept in later.dog Cloud." } });
  });

  it("refuses other methods and leaves other paths alone", async () => {
    const { call } = await serve();
    expect(await call("GET", "/api/vault/logins")).toEqual({ status: 405, body: { error: "Unsupported vault request." } });
    expect(await call("GET", "/api/vaults")).toEqual({ status: 404, body: { from: "inline routes" } });
  });
});
