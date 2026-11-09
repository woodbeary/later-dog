import { connect } from "node:net";
import { createInterface } from "node:readline";

const mode = process.argv[2] === "mcp" ? "mcp" : "hook";
const socketPath = mode === "mcp" ? process.argv[3] : process.env.LATERDOG_ENGINE_SOCKET;
const name = mode === "mcp" ? process.argv[4] ?? "" : "";
const hookIndex = mode === "hook" ? Number(process.argv[3] ?? 0) : 0;
if (!socketPath) process.exit(0);
const socket = connect(socketPath);
let finished = false;
const finish = (code: number) => {
  if (finished) return;
  finished = true;
  socket.destroy();
  process.exit(code);
};
const write = (frame: unknown) => socket.write(`${JSON.stringify(frame)}\n`);
const lines = createInterface({ input: socket });
lines.on("error", () => finish(mode === "hook" ? 0 : 1));
const timeout = mode === "hook" ? setTimeout(() => finish(0), 30_000) : null;
socket.on("error", () => finish(mode === "hook" ? 0 : 1));
socket.on("close", () => finish(mode === "hook" ? 0 : 1));
process.stdout.on("error", () => finish(0));
lines.on("line", line => {
  try {
    const frame = JSON.parse(line);
    if (frame.type === "stdout") process.stdout.write(Buffer.from(frame.data, "base64"));
    else if (frame.type === "stderr") process.stderr.write(Buffer.from(frame.data, "base64"));
    else if (frame.type === "exit") finish(Number.isInteger(frame.code) ? frame.code : 1);
    else if (frame.type === "hook_result") {
      if (timeout) clearTimeout(timeout);
      const body = frame.body ?? {};
      const code = Number.isInteger(body.code) ? body.code : 0;
      if (typeof body.stderr === "string" && body.stderr) process.stderr.write(body.stderr);
      process.stdout.write(typeof body.stdout === "string" ? body.stdout : "", () => finish(code));
    }
  } catch { finish(mode === "hook" ? 0 : 1); }
});
socket.on("connect", () => {
  if (mode === "mcp") {
    write({ type: "open", name });
    process.stdin.on("data", bytes => write({ type: "data", data: Buffer.from(bytes).toString("base64") }));
    process.stdin.on("end", () => write({ type: "end" }));
    process.stdin.on("error", () => finish(1));
  } else {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 1024 * 1024) finish(0);
    });
    process.stdin.on("end", () => {
      try { write({ type: "hook", index: Number.isSafeInteger(hookIndex) ? hookIndex : 0, payload: JSON.parse(text) }); } catch { finish(0); }
    });
    process.stdin.on("error", () => finish(0));
  }
});
