import { permissionMcpSession } from "./laterdog/permission-mcp-session.ts";

const session = permissionMcpSession(process.env, process.argv[2] ?? "", (msg) => process.stdout.write(JSON.stringify(msg) + "\n"));

let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let nl;
  while ((nl = inBuf.indexOf("\n")) !== -1) {
    const line = inBuf.slice(0, nl);
    inBuf = inBuf.slice(nl + 1);
    session.line(line);
  }
});
process.stdin.on("end", () => process.exit(0));
