import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APPS_SESSION_LABEL, createCloudAppsAccess, parseCloudAccess } from "./cloud-apps-access.mjs";

const ORIGIN = "https://abc-home.later.dog";
const destination = { kind: "cloud", origin: ORIGIN, grant: async () => ({ origin: ORIGIN, code: "ABCD-EFGH-JKLM" }) };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake({ rejectSaved = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init = {}) => {
    calls.push([init.method ?? "GET", new URL(url).pathname, init.body ? JSON.parse(init.body) : undefined]);
    if (new URL(url).pathname === "/api/auth/pair") return json(200, { token: `laterdog_sess_fresh${calls.length}` });
    if (new URL(url).pathname === "/api/bots") return rejectSaved ? json(401, { error: "unauthorized" }) : json(200, { bots: [] });
    return json(404, {});
  } };
}

test("signing in gives apps on this Mac a private session for My Cloud, once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-apps-access-"));
  const file = join(dir, "cloud-access.json");
  try {
    const f = fake();
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const first = await access.ensure(destination);
    assert.equal(first.url, ORIGIN);
    assert.match(first.token, /^laterdog_sess_/);
    assert.deepEqual(parseCloudAccess(JSON.parse(readFileSync(file, "utf8"))), first);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(f.calls.find(([, path]) => path === "/api/auth/pair")[2], { code: "ABCD-EFGH-JKLM", label: APPS_SESSION_LABEL });
    assert.equal(await access.ensure(destination), null, "nothing more happens for the same Cloud");
    await access.forget();
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a saved session the Cloud still accepts is kept; a refused one is replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-apps-access-"));
  const file = join(dir, "cloud-access.json");
  try {
    writeFileSync(file, JSON.stringify({ url: ORIGIN, token: "laterdog_sess_kept" }), { mode: 0o600 });
    const kept = fake();
    assert.equal((await createCloudAppsAccess({ file, fetchImpl: kept.fetchImpl }).ensure(destination)).token, "laterdog_sess_kept");
    assert.equal(kept.calls.some(([, path]) => path === "/api/auth/pair"), false);
    const refused = fake({ rejectSaved: true });
    assert.notEqual((await createCloudAppsAccess({ file, fetchImpl: refused.fetchImpl }).ensure(destination)).token, "laterdog_sess_kept");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
