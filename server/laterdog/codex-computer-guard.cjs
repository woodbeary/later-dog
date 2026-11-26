const { connect } = require("node:net");
const { createInterface } = require("node:readline");
const deny = () => {
  process.stderr.write("The home could not confirm the shell command.", () => process.exit(2));
};
const address = process.env.LATERDOG_ENGINE_SOCKET;
if (!address) deny();
else {
  const socket = connect(address);
  const timeout = setTimeout(deny, 20_000);
  socket.on("error", deny);
  socket.on("close", deny);
  const lines = createInterface({ input: socket });
  lines.once("line", line => {
    try {
      const reply = JSON.parse(line);
      if (reply.type !== "hook_result" || reply.body?.code !== 0) return deny();
      clearTimeout(timeout);
      socket.removeAllListeners("close");
      socket.end();
      process.stdout.write(reply.body.stdout ?? "", () => process.exit(0));
    } catch { deny(); }
  });
  socket.once("connect", () => {
    let bytes = 0;
    const chunks = [];
    process.stdin.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
      else deny();
    });
    process.stdin.on("error", deny);
    process.stdin.once("end", () => {
      try { socket.write(JSON.stringify({ type: "hook", index: 0, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) }) + "\n"); }
      catch { deny(); }
    });
  });
}
