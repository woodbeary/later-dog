import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_RENEW_ARGS } from "../server/laterdog/engine-renewal.ts";

const cli = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/verify-claude-sign-in-renewal.mjs <path to the pinned claude CLI>");
const root = mkdtempSync(join(tmpdir(), "laterdog-sign-in-renewal-"));
const tls = join(root, "tls");
mkdirSync(tls);
const names = ["platform.claude.com", "api.anthropic.com", "claude.ai", "*.claude.ai", "claude.com", "*.claude.com", "anthropic.com", "*.anthropic.com"];
writeFileSync(join(tls, "openssl.cnf"), `[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[leaf]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\n`);
const openssl = (...args) => execFileSync("openssl", args, { cwd: tls, stdio: "ignore" });
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=laterdog-fixture-ca", "-config", "openssl.cnf", "-extensions", "ca");
openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=platform.claude.com", "-config", "openssl.cnf");
openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "openssl.cnf", "-extensions", "leaf");

let requests = [];
const service = createHttpsServer({ key: readFileSync(join(tls, "leaf.key")), cert: readFileSync(join(tls, "leaf.pem")) }, (req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests.push({ host: req.headers.host, path: req.url, auth: String(req.headers.authorization ?? ""), body });
    if (req.method === "POST" && req.url.startsWith("/v1/oauth/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fixture-renewed-access", refresh_token: "fixture-renewed-refresh", expires_in: 28_800, token_type: "Bearer", scope: "user:inference user:profile user:sessions:claude_code" }));
    } else if (req.url.startsWith("/v1/messages")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "the fixture answers no model calls" } }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
});
const proxy = createHttpServer((_req, res) => { res.writeHead(502); res.end(); });
proxy.on("connect", (_req, socket) => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); service.emit("connection", socket); });
await new Promise((ready) => proxy.listen(0, "127.0.0.1", ready));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const account = (name, credential) => {
  const dir = join(root, name);
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "config", ".credentials.json"), JSON.stringify({ claudeAiOauth: { scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "max", ...credential } }), { mode: 0o600 });
  const env = { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "config"), HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: join(tls, "ca.pem"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  return { dir, env, saved: () => JSON.parse(readFileSync(join(dir, "config", ".credentials.json"), "utf8")).claudeAiOauth };
};
const run = (env, args, input) => new Promise((done) => {
  const child = spawn(cli, args, { cwd: env.CLAUDE_CONFIG_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (bytes) => { out += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.on("close", (code) => { clearTimeout(timer); done({ code, out }); });
  if (input) input(child, () => out); else child.stdin.end();
});
const tokenRequests = () => requests.filter((entry) => entry.path.startsWith("/v1/oauth/token"));
const modelRequests = () => requests.filter((entry) => entry.path.startsWith("/v1/messages"));
const report = {};

for (const [label, minutes, renews] of [["outside the CLI's own margin", 10, false], ["inside the CLI's own margin", 2, true], ["already expired", -1, true]]) {
  requests = [];
  const signIn = account(label.replace(/\W+/g, "-"), { accessToken: "fixture-old-access", refreshToken: "fixture-old-refresh", expiresAt: Date.now() + minutes * 60_000 });
  const status = await run(signIn.env, [...CLAUDE_RENEW_ARGS]);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.out).loggedIn, true);
  assert.equal(modelRequests().length, 0);
  assert.equal(tokenRequests().length, renews ? 1 : 0);
  if (renews) {
    assert.equal(JSON.parse(tokenRequests()[0].body).grant_type, "refresh_token");
    assert.equal(signIn.saved().accessToken, "fixture-renewed-access");
    assert.equal(signIn.saved().refreshToken, "fixture-renewed-refresh");
    assert.ok(signIn.saved().expiresAt > Date.now() + 7 * 3_600_000);
  } else assert.equal(signIn.saved().accessToken, "fixture-old-access");
  report[`${minutes} min left`] = { renewed: renews, tokenRequests: tokenRequests().length, modelRequests: modelRequests().length };
}

requests = [];
const lent = account("lent", { accessToken: "lent-access-one", expiresAt: Date.now() + 3 * 60_000 });
const message = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const results = (out) => out.split("\n").filter((line) => line.includes("\"type\":\"result\"")).length;
const waitFor = async (check) => { for (let tries = 0; tries < 120 && !check(); tries++) await new Promise((next) => setTimeout(next, 500)); assert.ok(check()); };
await run(lent.env, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "haiku"], async (child, out) => {
  child.stdin.write(message("one"));
  await waitFor(() => results(out()) >= 1);
  const file = join(lent.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  writeFileSync(`${file}.next`, JSON.stringify({ claudeAiOauth: { accessToken: "lent-access-two", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  renameSync(`${file}.next`, file);
  child.stdin.write(message("two"));
  await waitFor(() => results(out()) >= 2);
  child.stdin.end();
});
assert.equal(tokenRequests().length, 0);
assert.deepEqual(modelRequests().map((entry) => entry.auth), ["Bearer lent-access-one", "Bearer lent-access-two"]);
report["running engine, lent sign-in without refresh token"] = { tokenRequests: 0, modelCallTokens: ["first lent", "replaced file"] };

proxy.close();
service.close();
appendFileSync(join(root, "report.json"), JSON.stringify(report));
console.log(JSON.stringify({ cli: execFileSync(cli, ["--version"], { encoding: "utf8" }).trim(), ...report }, null, 2));
