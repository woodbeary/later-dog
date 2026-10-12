import { cuaExecArgs } from "./container-computer.ts";
import { runMcpBridge } from "./mcp-bridge.ts";

const [runtime, container, socket] = process.argv.slice(2);
if (!runtime || !["docker", "podman", "container"].includes(runtime)) {
  process.stderr.write("invalid Local VM runtime\n");
  process.exit(2);
}
if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container) || !socket?.startsWith("/run/user/1000/")) {
  process.stderr.write("invalid Local VM connection\n");
  process.exit(2);
}

const controlUrl = process.env.LATERDOG_CONTROL_URL ?? "";
const controlToken = process.env.LATERDOG_CONTROL_TOKEN ?? "";

runMcpBridge({
  command: runtime,
  args: cuaExecArgs(["mcp", "--socket", socket], { container, interactive: true }),
  label: "Cua Driver",
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
