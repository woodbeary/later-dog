import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import net from "node:net";
import { fileURLToPath } from "node:url";

export const HOME_PATHS = ["/api/", "/.well-known/laterdog/", "/v1/"];
export const SESSION_TOKEN = /^laterdog_sess_[A-Za-z0-9_-]+$/;

export function readSession(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const url = new URL(saved.url);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`${file} does not point at an https home`);
  if (typeof saved.token !== "string" || !SESSION_TOKEN.test(saved.token)) throw new Error(`${file} has no home session`);
  return { url, token: saved.token };
}

export function goesToHome(path) {
  return HOME_PATHS.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

export function homeHeaders(headers, home) {
  const next = { ...headers, host: home.url.host, authorization: `Bearer ${home.token}` };
  delete next.origin;
  delete next.referer;
  delete next.cookie;
  return next;
}

export function startHomeProxy({ session, port, host = "127.0.0.1", fallback = null, log = () => {} }) {
  const home = readSession(session);
  const secure = home.url.protocol === "https:";
  const homePort = Number(home.url.port) || (secure ? 443 : 80);
  const server = http.createServer((req, res) => {
    const toHome = goesToHome(req.url ?? "/");
    if (!toHome && !fallback) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "the dev home proxy only forwards later.dog API paths" }));
    }
    const target = toHome ? { url: home.url, secure, port: homePort } : { url: fallback, secure: fallback.protocol === "https:", port: Number(fallback.port) || (fallback.protocol === "https:" ? 443 : 80) };
    const started = Date.now();
    const outgoing = (target.secure ? https : http).request({
      hostname: target.url.hostname, port: target.port, path: req.url, method: req.method,
      headers: toHome ? homeHeaders(req.headers, home) : req.headers, servername: target.url.hostname,
    }, (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(res);
      if (toHome) incoming.on("end", () => log(`${req.method} ${req.url} ${incoming.statusCode} ${Date.now() - started}ms`));
    });
    outgoing.on("error", (error) => {
      log(`${req.method} ${req.url} failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `dev home proxy: ${error.message}` }));
    });
    req.pipe(outgoing);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!goesToHome(req.url ?? "/")) return socket.destroy();
    const headers = homeHeaders(req.headers, home);
    const upstream = secure
      ? tls.connect({ host: home.url.hostname, port: homePort, servername: home.url.hostname })
      : net.connect({ host: home.url.hostname, port: homePort });
    upstream.once(secure ? "secureConnect" : "connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => `${name}: ${one}`)), "", ""];
      upstream.write(lines.join("\r\n"));
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.address().port}`, home: home.url.origin }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [session, port = "8096", host = "127.0.0.1"] = process.argv.slice(2);
  if (!session) {
    process.stderr.write("usage: node scripts/dev-home-proxy.mjs <session.json> [port] [host]\n");
    process.exit(2);
  }
  const fallback = process.env.LATERDOG_DEV_FALLBACK_URL ? new URL(process.env.LATERDOG_DEV_FALLBACK_URL) : null;
  startHomeProxy({ session, port: Number(port), host, fallback, log: (line) => process.stdout.write(`home proxy: ${line}\n`) })
    .then(({ url, home }) => process.stdout.write(`home proxy: ${url} -> ${home}\n`))
    .catch((error) => {
      process.stderr.write(`home proxy: ${error.message}\n`);
      process.exit(1);
    });
}
