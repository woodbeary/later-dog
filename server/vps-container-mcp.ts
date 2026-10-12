import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { prepareVpsSsh } from "./vps-ssh.ts";

const [alias, containerName] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "");
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

const controlUrl = process.env.LATERDOG_CONTROL_URL ?? "";
const controlToken = process.env.LATERDOG_CONTROL_TOKEN ?? "";
const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());

runMcpBridge({
  command: "docker",
  args,
  env: { ...process.env, PATH: ssh.path },
  label: "VPS Cua Driver",
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
