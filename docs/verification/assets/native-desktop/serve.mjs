import { createServer, request } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const [dist, home, port] = process.argv.slice(2);
const target = new URL(home);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".ico": "image/x-icon", ".webp": "image/webp" };

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/api/")) {
    const upstream = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
    return;
  }
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, safe);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${dist} with ${home} on http://127.0.0.1:${port}`));
