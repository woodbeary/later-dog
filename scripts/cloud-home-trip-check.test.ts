import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudPairingSignature, createCloudPairing } from "../server/cloud-home.ts";
import { arrivalProblems, chatCount, edgeFetch, mintHomeCode, pairingSignature, textLines } from "./cloud-home-trip-check.mjs";

const HOST = "h0123456789abcdef01234567-home.later.dog";
const ORIGIN = `https://${HOST}`;
const SECRET = "s".repeat(43);

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }
let server: Server;
let base: string;
const seen: Seen[] = [];
const routes = new Map<string, (req: IncomingMessage, res: ServerResponse, body: Buffer) => void>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const route = routes.get(new URL(req.url ?? "/", "http://stub.invalid").pathname);
      if (route) route(req, res, body);
      else { res.writeHead(200, { "content-type": "application/json", "x-stub": "yes" }); res.end(JSON.stringify({ ok: true })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the stub did not listen");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const last = () => seen.at(-1)!;

describe("edgeFetch", () => {
  it("sends the home's own host and the edge's client headers to the container's port, keeping path and query", async () => {
    const fetchHome = edgeFetch({ base, origin: ORIGIN, headers: { "x-laterdog-client-ip": "203.0.113.5" } });
    const response = await fetchHome(`${ORIGIN}/api/bots?messages=0`, { headers: { authorization: "Bearer laterdog_sess_x" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-stub")).toBe("yes");
    expect(await response.json()).toEqual({ ok: true });
    expect(last()).toMatchObject({ method: "GET", url: "/api/bots?messages=0" });
    expect(last().headers).toMatchObject({ host: HOST, "x-laterdog-client-ip": "203.0.113.5", authorization: "Bearer laterdog_sess_x" });
  });

  it("carries string, Buffer and offset byte views exactly, with their length", async () => {
    const fetchHome = edgeFetch({ base, origin: ORIGIN });
    await fetchHome(`${ORIGIN}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "ABCD" }) });
    expect(last()).toMatchObject({ method: "POST" });
    expect(last().body.toString()).toBe('{"code":"ABCD"}');
    expect(last().headers["content-length"]).toBe("15");
    await fetchHome(`${ORIGIN}/api/cloud-move/upload/part`, { method: "PUT", body: Buffer.from([1, 2, 3, 4]) });
    expect([...last().body]).toEqual([1, 2, 3, 4]);
    await fetchHome(`${ORIGIN}/api/cloud-move/upload/part`, { method: "PUT", body: new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4) });
    expect([...last().body]).toEqual([8, 7, 6]);
    expect(last().headers["content-length"]).toBe("3");
    await fetchHome(`${ORIGIN}/api/auth/logout`, { method: "POST" });
    expect(last().headers).toMatchObject({ "content-length": "0" });
    expect(last().headers["transfer-encoding"]).toBeUndefined();
  });

  it("refuses any origin other than the home before sending anything", async () => {
    const fetchHome = edgeFetch({ base, origin: ORIGIN });
    const before = seen.length;
    await expect(fetchHome("https://accounts.later.dog/api/bots")).rejects.toThrow(TypeError);
    await expect(fetchHome(`${base}/api/bots`)).rejects.toThrow(TypeError);
    expect(seen.length).toBe(before);
  });

  it("answers a no-content status without a body and refuses redirects when asked to", async () => {
    routes.set("/empty", (_req, res) => { res.writeHead(204); res.end(); });
    routes.set("/moved", (_req, res) => { res.writeHead(302, { location: "https://elsewhere.example/" }); res.end(); });
    const fetchHome = edgeFetch({ base, origin: ORIGIN });
    const empty = await fetchHome(`${ORIGIN}/empty`, { method: "POST", body: "{}" });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    await expect(fetchHome(`${ORIGIN}/moved`, { redirect: "error" })).rejects.toThrow(TypeError);
    expect((await fetchHome(`${ORIGIN}/moved`)).status).toBe(302);
  });

  it("streams a live answer as it comes and stops it when its signal aborts", async () => {
    routes.set("/api/events", (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("event: hello\ndata: {}\n\n"); });
    const fetchHome = edgeFetch({ base, origin: ORIGIN });
    const watching = new AbortController();
    const stream = await fetchHome(`${ORIGIN}/api/events`, { signal: watching.signal });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
    watching.abort();
    await expect(reader.read()).rejects.toBeDefined();
    const stopped = new AbortController();
    stopped.abort(new Error("stopped early"));
    await expect(fetchHome(`${ORIGIN}/api/bots`, { signal: stopped.signal })).rejects.toThrow("stopped early");
  });
});

describe("signed pairing", () => {
  it("signs exactly as the server checks it", () => {
    const body = JSON.stringify({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
    expect(pairingSignature(SECRET, "1760000000", "n".repeat(24), body)).toBe(cloudPairingSignature(SECRET, "1760000000", "n".repeat(24), body));
  });

  it("is accepted by the server's own pairing check, and a wrong secret is refused with its status", async () => {
    const sessions = {
      attemptAllowed: () => ({ ok: true as const }), noteFailure: () => {}, clearFailures: () => {},
      openPairing: () => ({ id: "p1", code: "ABCDEFGHJKMN", credential: `laterdog_pair_${"c".repeat(20)}`, expiresAt: Date.now() + 300_000 }),
    };
    const pairing = createCloudPairing({ secret: SECRET, sessions });
    routes.set("/api/cloud/pairing", (req, res, body) => {
      const header = (name: string) => { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; };
      const answer = pairing.handle({ timestamp: header("x-laterdog-cloud-timestamp"), nonce: header("x-laterdog-cloud-nonce"), signature: header("x-laterdog-cloud-signature"), body, source: "203.0.113.5" });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
    const fetchHome = edgeFetch({ base, origin: ORIGIN });
    const grant = await mintHomeCode(fetchHome, ORIGIN, SECRET, "later.dog app (Cloud)");
    expect(grant).toMatchObject({ origin: ORIGIN, code: "ABCD-EFGH-JKMN" });
    expect(JSON.parse(last().body.toString())).toEqual({ label: "later.dog app (Cloud)", ttlSeconds: 300 });
    await expect(mintHomeCode(fetchHome, ORIGIN, "w".repeat(43), "later.dog app (Cloud)")).rejects.toMatchObject({ status: 401 });
  });
});

describe("comparing the desktop with the home", () => {
  const dog = (name: string, lines: Array<[string, string]>) => ({ name, lines: lines.map(([role, text]) => ({ role, text })) });
  const desktop = [
    dog("Fixture Starter", [["user", "hello starter"], ["bot", "hi"]]),
    dog("Trip Planner", [["user", "plan it"], ["bot", "planned"]]),
    dog("Trip Writer", []),
  ];

  it("finds nothing wrong when the home has the same dogs and every line in order, with newer lines after them", () => {
    const home = [desktop[2]!, desktop[0]!, dog("Trip Planner", [["user", "plan it"], ["bot", "planned"], ["user", "from the phone"]])];
    expect(arrivalProblems(desktop, home)).toEqual([]);
  });

  it("names a missing or extra dog", () => {
    expect(arrivalProblems(desktop, desktop.slice(0, 2)).join("\n")).toContain("Trip Writer");
    expect(arrivalProblems(desktop, [...desktop, dog("Stranger", [])]).join("\n")).toContain("Stranger");
  });

  it("names a dog whose chat lost a line, changed who said it, or came back out of order", () => {
    const lost = [desktop[0]!, dog("Trip Planner", [["user", "plan it"]]), desktop[2]!];
    expect(arrivalProblems(desktop, lost)).toEqual([expect.stringContaining("Trip Planner's chat on the home is missing the bot line")]);
    const swapped = [desktop[0]!, dog("Trip Planner", [["bot", "plan it"], ["bot", "planned"]]), desktop[2]!];
    expect(arrivalProblems(desktop, swapped)).toEqual([expect.stringContaining("missing the user line")]);
    const reordered = [desktop[0]!, dog("Trip Planner", [["bot", "planned"], ["user", "plan it"]]), desktop[2]!];
    expect(arrivalProblems(desktop, reordered)).toHaveLength(1);
  });

  it("reads only spoken text lines and counts a chat once a person wrote in it", () => {
    const lines = textLines([
      { role: "user", kind: "text", text: "hello" },
      { role: "bot", kind: "activity", text: "ran a tool" },
      { role: "bot", kind: "text", text: "  " },
      { role: "system", kind: "text", text: "note" },
      { role: "bot", kind: "text", text: "hi" },
      null,
    ]);
    expect(lines).toEqual([{ role: "user", text: "hello" }, { role: "bot", text: "hi" }]);
    expect(textLines(undefined)).toEqual([]);
    expect(chatCount(desktop)).toBe(2);
  });
});
