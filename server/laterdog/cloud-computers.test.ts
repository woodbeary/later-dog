// The computers client against a fake fetch: where its connection comes from, what each call sends, what crosses back,
// and that the key never appears anywhere but the Authorization header.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComputersApiError, ComputersClient, ComputersConfigError, MAX_FRAME_BYTES, computersConnection, computersSelected, type ComputersConnection,
} from "./cloud-computers.ts";

const KEY = `ldc_${"k".repeat(40)}`;
type Call = { url: URL; method: string; headers: Headers; body: unknown };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const computer = (id = "cmp_one", state = "running") => ({ id, name: "dog-0123456789ab-research-a1b2c3", state });
function service(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const call = { url: new URL(String(input)), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}
async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try { await promise; } catch (error) { return error as Error & Record<string, unknown>; }
  throw new Error("expected a rejection");
}

let home: string;
let connection: ComputersConnection;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "laterdog-computers-"));
  vi.stubEnv("LATERDOG_HOME", home); vi.stubEnv("LATERDOG_COMPUTERS_API", ""); vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", "");
  writeFileSync(join(home, "computers-key"), `${KEY}\n`, { mode: 0o600 });
  connection = { api: "https://computers.example.test/v1", keyFile: join(home, "computers-key"), source: "file" };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("choosing later.dog's computers", () => {
  it("uses none until the environment or computers.json names a service, with the environment winning", () => {
    expect(computersSelected()).toBe(false);
    expect(computersConnection()).toBeNull();
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: "https://laterdog-computers.example.test/v1/" }));
    expect(computersSelected()).toBe(true);
    expect(computersConnection()).toEqual({ api: "https://laterdog-computers.example.test/v1", keyFile: join(home, "computers-key"), source: "file" });
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: "https://laterdog-computers.example.test/v1", keyFile: "/secure/computers-key" }));
    expect(computersConnection()?.keyFile).toBe("/secure/computers-key");
    vi.stubEnv("LATERDOG_COMPUTERS_API", "http://127.0.0.1:8787/v1"); vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", "/tmp/fixture-key");
    expect(computersConnection()).toEqual({ api: "http://127.0.0.1:8787/v1", keyFile: "/tmp/fixture-key", source: "environment" });
  });

  it("refuses a service it must not send the key to, without echoing what was written", () => {
    const refused = (api: string) => {
      writeFileSync(join(home, "computers.json"), JSON.stringify({ api }));
      const error = (() => { try { computersConnection(); } catch (caught) { return caught as Error; } throw new Error("accepted"); })();
      expect(error).toBeInstanceOf(ComputersConfigError);
      expect((error as ComputersConfigError).status).toBe(409);
      return error.message;
    };
    expect(refused("http://computers.example.test/v1")).toMatch(/HTTPS/);
    expect(refused("https://user:hunter2@computers.example.test/v1")).not.toContain("hunter2");
    expect(refused(`https://computers.example.test/v1?key=${KEY}`)).not.toContain(KEY);
    expect(refused("not a url")).toMatch(/HTTPS/);
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: "https://computers.example.test/v1", keyFile: "relative/key" }));
    expect(() => computersConnection()).toThrow(/absolute/);
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: "https://computers.example.test/v1", key: KEY }));
    expect(() => computersConnection()).toThrow(ComputersConfigError);
    try { computersConnection(); } catch (error) { expect((error as Error).message).not.toContain(KEY); }
    writeFileSync(join(home, "computers.json"), "{");
    expect(() => computersConnection()).toThrow(/not valid JSON/);
  });

  it("needs an existing key file holding an ldc_ key, and never shows the key", () => {
    expect(() => new ComputersClient({ ...connection, keyFile: join(home, "missing") })).toThrow(/does not exist/);
    writeFileSync(join(home, "boat-key"), "box_pasted_into_the_wrong_file");
    const wrong = (() => { try { new ComputersClient({ ...connection, keyFile: join(home, "boat-key") }); } catch (error) { return error as Error; } throw new Error("accepted"); })();
    expect(wrong.message).toMatch(/start with ldc_/);
    expect(wrong.message).not.toContain("box_pasted");
    const client = new ComputersClient(connection);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(inspect(client, { depth: 5 })).not.toContain(KEY);
  });
});

describe("the computers API", () => {
  it("sends each call to its documented path with the key only as a bearer", async () => {
    const { calls, fetch } = service((call) => {
      const path = `${call.method} ${call.url.pathname}`;
      if (path === "POST /v1/computers") return json(201, { computer: computer() });
      if (path === "GET /v1/computers") return json(200, { computers: [computer()] });
      if (path === "DELETE /v1/computers/cmp_one") return json(200, { deleted: true });
      if (path.endsWith("/exec")) return json(200, { exitCode: 0, stdout: "hi\n", stderr: "" });
      if (path.endsWith("/desktop")) return json(200, { url: "https://desktop.example.test/cmp_one?token=signed", expiresAt: "2026-10-08T12:00:00Z" });
      if (path.endsWith("/files") && call.method === "GET") return new Response(Buffer.from("file bytes"), { status: 200 });
      if (path.endsWith("/files")) return new Response(null, { status: 204 });
      return json(200, { computer: computer() });
    });
    const client = new ComputersClient(connection, { fetch });
    await client.create({ name: "dog-0123456789ab-research-a1b2c3" }, "ldc-create-fixture");
    await client.list();
    await client.get("cmp_one");
    await client.rename("cmp_one", "dog-0123456789ab-research-a1b2c3");
    await client.wake("cmp_one");
    await client.sleep("cmp_one");
    expect(await client.exec("cmp_one", { command: "echo hi", timeoutMs: 5_000, cwd: "/home/dog" })).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(await client.desktop("cmp_one")).toEqual({ url: "https://desktop.example.test/cmp_one?token=signed", expiresAt: "2026-10-08T12:00:00Z" });
    expect((await client.readFile("cmp_one", "/home/dog/a b.txt")).toString()).toBe("file bytes");
    await client.writeFile("cmp_one", "/home/dog/out.bin", new Uint8Array([1, 2, 3]));
    expect(await client.remove("cmp_one")).toBe("deleted");

    expect(calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`)).toEqual([
      "POST /v1/computers", "GET /v1/computers", "GET /v1/computers/cmp_one", "PATCH /v1/computers/cmp_one",
      "POST /v1/computers/cmp_one/wake", "POST /v1/computers/cmp_one/sleep", "POST /v1/computers/cmp_one/exec",
      "POST /v1/computers/cmp_one/desktop", "GET /v1/computers/cmp_one/files?path=%2Fhome%2Fdog%2Fa%20b.txt",
      "PUT /v1/computers/cmp_one/files?path=%2Fhome%2Fdog%2Fout.bin", "DELETE /v1/computers/cmp_one",
    ]);
    expect(calls.every((call) => call.url.origin === "https://computers.example.test" && call.headers.get("authorization") === `Bearer ${KEY}`)).toBe(true);
    expect(calls.filter((call) => call.headers.has("idempotency-key")).map((call) => call.headers.get("idempotency-key"))).toEqual(["ldc-create-fixture"]);
    expect(JSON.parse(String(calls[0].body))).toEqual({ name: "dog-0123456789ab-research-a1b2c3" });
    expect(JSON.parse(String(calls[3].body))).toEqual({ name: "dog-0123456789ab-research-a1b2c3" });
    expect(JSON.parse(String(calls[6].body))).toEqual({ command: "echo hi", timeoutMs: 5_000, cwd: "/home/dog" });
    expect(calls[9].body).toEqual(new Uint8Array([1, 2, 3]));
    for (const call of calls) expect(call.url.href).not.toContain(KEY);
  });

  it("keeps only a computer's id, name and state", async () => {
    const { fetch } = service(() => json(200, { computer: { ...computer(), size: "standard", desktopUrl: "https://secret.example/?token=do-not-leak", address: "203.0.113.8" } }));
    expect(await new ComputersClient(connection, { fetch }).get("cmp_one")).toEqual(computer());
  });

  it("fails a malformed answer closed instead of reading it as absence", async () => {
    const list = service(() => json(200, { computers: [computer(), { id: "bad/id", name: "dog-x", state: "running" }] }));
    expect(await rejection(new ComputersClient(connection, { fetch: list.fetch }).list())).toMatchObject({ httpStatus: 502, code: "invalid_response" });
    const other = service(() => json(200, { computer: computer("cmp_other") }));
    expect(await rejection(new ComputersClient(connection, { fetch: other.fetch }).get("cmp_one"))).toMatchObject({ message: expect.stringMatching(/different cloud computer/) });
    const garbage = service(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await rejection(new ComputersClient(connection, { fetch: garbage.fetch }).list())).toMatchObject({ httpStatus: 502, code: "invalid_response" });
    const untouched = service(() => json(200, {}));
    expect(await rejection(new ComputersClient(connection, { fetch: untouched.fetch }).get("../computers"))).toMatchObject({ status: 400 });
    expect(untouched.calls).toHaveLength(0);
  });

  it("reads refusals as the service's status, code and words, and a rejected key by its file", async () => {
    const { fetch } = service((call) => call.url.pathname.endsWith("/exec")
      ? json(409, { error: { code: "asleep", message: "the computer is asleep" } })
      : call.url.pathname.endsWith("/wake") ? json(429, { error: { code: "Not A Code!", message: "" } })
        : json(401, { error: { code: "unauthorized", message: "bad key" } }));
    const client = new ComputersClient(connection, { fetch });
    const asleep = await rejection(client.exec("cmp_one", { command: "true" }));
    expect(asleep).toBeInstanceOf(ComputersApiError);
    expect(asleep).toMatchObject({ httpStatus: 409, code: "asleep", message: "the computer is asleep" });
    expect(asleep.status).toBeUndefined();
    expect(await rejection(client.wake("cmp_one"))).toMatchObject({ httpStatus: 429, code: undefined, message: expect.stringMatching(/rate-limiting/) });
    const rejected = await rejection(client.list());
    expect(rejected).toMatchObject({ httpStatus: 401, code: "unauthorized" });
    expect(rejected.message).toContain(connection.keyFile);
    expect(rejected.message).not.toContain(KEY);
  });

  it("treats a missing computer as null on read and as done on delete", async () => {
    const { fetch } = service(() => json(404, { error: { code: "not_found", message: "no such computer" } }));
    const client = new ComputersClient(connection, { fetch });
    expect(await client.get("cmp_gone")).toBeNull();
    expect(await client.remove("cmp_gone")).toBe("absent");
  });

  it("reports an unreachable service as status 0 and passes a caller's cancel through as it is", async () => {
    const down = service(() => { throw new TypeError("fetch failed"); });
    expect(await rejection(new ComputersClient(connection, { fetch: down.fetch }).list())).toMatchObject({ httpStatus: 0, message: expect.stringMatching(/could not be reached/) });
    const cancel = new AbortController(); cancel.abort();
    const up = service(() => json(200, { computer: computer() }));
    const aborted = await rejection(new ComputersClient(connection, { fetch: up.fetch }).get("cmp_one", { signal: cancel.signal }));
    expect(aborted.name).toBe("AbortError");
    expect(aborted).not.toBeInstanceOf(ComputersApiError);
  });

  it("retries an ambiguous create once with the same key, and never a refusal", async () => {
    const answers: Array<() => Response> = [() => { throw new TypeError("socket hang up"); }, () => json(201, { computer: computer() })];
    const lost = service(() => answers.shift()!());
    expect(await new ComputersClient(connection, { fetch: lost.fetch }).create({ name: "dog-x" }, "ldc-create-one")).toEqual(computer());
    expect(lost.calls.map((call) => call.headers.get("idempotency-key"))).toEqual(["ldc-create-one", "ldc-create-one"]);
    const failing = [json(503, {}), json(201, { computer: computer() })];
    const outage = service(() => failing.shift()!);
    await new ComputersClient(connection, { fetch: outage.fetch }).create({ name: "dog-x" }, "ldc-create-two");
    expect(outage.calls).toHaveLength(2);
    const refusal = service(() => json(402, { error: { code: "at_once", message: "Your plan includes 2 cloud computers at once" } }));
    expect(await rejection(new ComputersClient(connection, { fetch: refusal.fetch }).create({ name: "dog-x" }, "ldc-create-three"))).toMatchObject({ httpStatus: 402, code: "at_once" });
    expect(refusal.calls).toHaveLength(1);
    const gone = service(() => { throw new TypeError("fetch failed"); });
    expect(await rejection(new ComputersClient(connection, { fetch: gone.fetch }).create({ name: "dog-x" }, "ldc-create-four"))).toMatchObject({ httpStatus: 0 });
    expect(gone.calls).toHaveLength(2);
  });

  it("returns a JPEG frame and refuses one over 8 MB whatever its length header says", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const frame = service(() => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect(await new ComputersClient(connection, { fetch: frame.fetch }).screenshot("cmp_one")).toEqual(jpeg);
    expect(frame.calls[0].headers.get("accept")).toBe("image/jpeg");

    const declared = service(() => new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(MAX_FRAME_BYTES + 1) } }));
    expect((await rejection(new ComputersClient(connection, { fetch: declared.fetch }).screenshot("cmp_one"))).message).toMatch(/8 MB/);
    let sent = 0;
    const endless = service(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { sent += 1024 * 1024; controller.enqueue(new Uint8Array(1024 * 1024)); if (sent > 64 * 1024 * 1024) controller.close(); },
    }), { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect((await rejection(new ComputersClient(connection, { fetch: endless.fetch }).screenshot("cmp_one"))).message).toMatch(/8 MB/);
    expect(sent).toBeLessThanOrEqual(MAX_FRAME_BYTES + 2 * 1024 * 1024);

    const png = service(() => new Response(jpeg, { status: 200, headers: { "content-type": "image/png" } }));
    expect(await rejection(new ComputersClient(connection, { fetch: png.fetch }).screenshot("cmp_one"))).toMatchObject({ code: "invalid_response" });
    const empty = service(() => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect(await rejection(new ComputersClient(connection, { fetch: empty.fetch }).screenshot("cmp_one"))).toMatchObject({ code: "invalid_response" });
  });

  it("hands back only a desktop link the viewer can open", async () => {
    const link = (url: string) => service(() => json(200, { url })).fetch;
    expect((await new ComputersClient(connection, { fetch: link("https://desktop.example.test/v?token=signed") }).desktop("cmp_one")).url).toBe("https://desktop.example.test/v?token=signed");
    expect((await new ComputersClient(connection, { fetch: link("http://127.0.0.1:6080/vnc.html") }).desktop("cmp_one")).url).toBe("http://127.0.0.1:6080/vnc.html");
    for (const url of ["http://desktop.example.test/v", "javascript:alert(1)", "https://user:pw@desktop.example.test/v"]) {
      expect(await rejection(new ComputersClient(connection, { fetch: link(url) }).desktop("cmp_one"))).toMatchObject({ code: "invalid_response" });
    }
  });
});
