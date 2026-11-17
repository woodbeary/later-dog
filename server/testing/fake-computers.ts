import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { isPoll } from "./poll-answer.ts";

export interface FakeComputers { url: string; execs: Array<{ at: number; command: string }>; polls(): number; started(): boolean; remote: string; close(): Promise<void> }

export async function startFakeComputers(root: string): Promise<FakeComputers> {
  const remote = join(root, "remote-home");
  mkdirSync(join(remote, ".local/bin"), { recursive: true });
  writeFileSync(join(remote, ".local/bin/pnpm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(remote, ".local/bin/pnpm"), 0o755);
  const computers = new Map<string, { id: string; name: string; state: string }>();
  const execs: Array<{ at: number; command: string }> = [];
  const body = (req: http.IncomingMessage) => new Promise<Buffer>((resolve) => { const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
  const json = (res: http.ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "computers") return json(res, 404, { error: { code: "not_found", message: "no" } });
    if (parts.length === 1 && req.method === "GET") return json(res, 200, { computers: [...computers.values()] });
    if (parts.length === 1 && req.method === "POST") {
      const input = JSON.parse((await body(req)).toString("utf8")) as { name: string };
      const computer = { id: "cmp_fake1", name: input.name, state: "running" };
      computers.set(computer.id, computer);
      return json(res, 200, { computer });
    }
    const computer = computers.get(parts[1] ?? "");
    if (!computer) return json(res, 404, { error: { code: "not_found", message: "no such computer" } });
    if (parts.length === 2 && req.method === "GET") return json(res, 200, { computer });
    if (parts[2] === "wake") return json(res, 200, { computer });
    if (parts[2] === "files") {
      const target = join(remote, url.searchParams.get("path") ?? "");
      if (req.method === "PUT") { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, await body(req)); res.writeHead(200); return res.end("{}"); }
      try { const bytes = readFileSync(target); res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(bytes); } catch { return json(res, 404, { error: { code: "not_found", message: "no file" } }); }
    }
    if (parts[2] === "exec" && req.method === "POST") {
      const input = JSON.parse((await body(req)).toString("utf8")) as { command: string; timeoutMs?: number };
      execs.push({ at: Date.now(), command: input.command });
      const child = spawn("bash", ["-c", input.command], { cwd: remote, env: { ...process.env, HOME: remote }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs ?? 120_000);
      child.on("close", (code) => { clearTimeout(timer); json(res, 200, { exitCode: code, stdout, stderr }); });
      return;
    }
    return json(res, 404, { error: { code: "not_found", message: "unsupported" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, execs, remote,
    polls: () => execs.filter((e) => isPoll(e.command)).length,
    started: () => execs.some((e) => e.command.includes("nohup")),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
