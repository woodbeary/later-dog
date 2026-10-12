import { homedir, userInfo } from "node:os";
import { posix } from "node:path";

const { basename, dirname, join } = posix;

export interface ServiceSpec {
  node: string;
  script: string;
  serveArgs: string[];
  dataDir: string;
  user: string;
  home: string;
  bindsLowPorts: boolean;
  label?: string;
}

export const SYSTEMD_UNIT_NAME = "laterdog.service";
export const LAUNCHD_LABEL = "com.laterdog.serve";

function quoteSystemd(value: string): string {
  return /[\s"\\]/.test(value) ? `"${value.replace(/[\\"]/g, "\\$&")}"` : value;
}

function needsStripTypes(script: string): boolean {
  return script.endsWith(".ts");
}

export function serviceCommand(spec: Pick<ServiceSpec, "node" | "script" | "serveArgs">): string[] {
  return [spec.node, ...(needsStripTypes(spec.script) ? ["--experimental-strip-types"] : []), spec.script, "serve", ...spec.serveArgs];
}

export function systemdUnit(spec: ServiceSpec): string {
  const lines = [
    "# Written by `laterdog service install`. Re-run it to change the options.",
    "[Unit]",
    `Description=later.dog${spec.label ? ` (${spec.label})` : ""}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${spec.user}`,
    `WorkingDirectory=${spec.home}`,
    `Environment=HOME=${spec.home}`,
    `Environment=LATERDOG_HOME=${spec.dataDir}`,
    `ExecStart=${serviceCommand(spec).map(quoteSystemd).join(" ")}`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=30",
  ];
  if (spec.bindsLowPorts) {
    lines.push("# serve --domain: Caddy binds ports 80 and 443 without running as root.");
    lines.push("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    lines.push("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
  }
  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = serviceCommand(spec).map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>HOME</key>",
    `\t\t<string>${xml(spec.home)}</string>`,
    "\t\t<key>LATERDOG_HOME</key>",
    `\t\t<string>${xml(spec.dataDir)}</string>`,
    "\t\t<key>PATH</key>",
    "\t\t<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>",
    "\t</dict>",
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xml(spec.home)}</string>`,
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(join(spec.dataDir, "logs", "service.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function unstableInstallWarning(script: string): string | null {
  const normalized = script.replace(/\\/g, "/");
  if (/\/_npx\//.test(normalized) || /\/\.npm\/_npx\//.test(normalized)) {
    return `this command runs from an npx cache (${dirname(script)}), which npm may delete at any time. Install it permanently first (npm install -g laterdog) and run \`laterdog service install\` from that install.`;
  }
  return null;
}

export function servicePlan(platform: NodeJS.Platform, dataDir: string, home = homedir()): { file: string; installed: string; activate: string[]; deactivate: string[] } | null {
  if (platform === "linux") {
    const installed = `/etc/systemd/system/${SYSTEMD_UNIT_NAME}`;
    return {
      file: join(dataDir, SYSTEMD_UNIT_NAME),
      installed,
      activate: [`sudo install -m 644 ${join(dataDir, SYSTEMD_UNIT_NAME)} ${installed}`, "sudo systemctl daemon-reload", `sudo systemctl enable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`],
      deactivate: [`sudo systemctl disable --now ${basename(SYSTEMD_UNIT_NAME, ".service")}`, `sudo rm ${installed}`, "sudo systemctl daemon-reload"],
    };
  }
  if (platform === "darwin") {
    const installed = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return {
      file: join(dataDir, `${LAUNCHD_LABEL}.plist`),
      installed,
      activate: [`mkdir -p ${dirname(installed)} && cp ${join(dataDir, `${LAUNCHD_LABEL}.plist`)} ${installed}`, `launchctl bootstrap gui/$(id -u) ${installed}`],
      deactivate: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, `rm ${installed}`],
    };
  }
  return null;
}

export function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "laterdog";
  }
}
