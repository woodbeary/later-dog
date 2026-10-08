import { describe, expect, it } from "vitest";

import { launchdPlist, serviceCommand, servicePlan, systemdUnit, unstableInstallWarning, type ServiceSpec } from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/laterdog/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/dog/.laterdog", "--domain", "dog.example.com", "--no-pair"],
  dataDir: "/home/dog/.laterdog",
  user: "dog",
  home: "/home/dog",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/laterdog/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/later.dog/server/laterdog.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=later.dog (agentada)");
    expect(unit).toContain("User=dog");
    expect(unit).toContain("Environment=LATERDOG_HOME=/home/dog/.laterdog");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/laterdog/cli.js serve --port 8799 --data-dir /home/dog/.laterdog --domain dog.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/dog/.laterdog"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    // a path with a space is quoted for systemd
    expect(systemdUnit({ ...spec, dataDir: "/home/dog/My Data", serveArgs: ["--data-dir", "/home/dog/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/laterdog/cli.js serve --data-dir "/home/dog/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/dog", dataDir: "/Users/dog/.laterdog" });
    expect(plist).toContain("<string>com.laterdog.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>dog.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/dog/.laterdog/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/dog/.npm/_npx/abc123/node_modules/laterdog/cli.js")).toMatch(/npm install -g laterdog/);
    expect(unstableInstallWarning("/usr/lib/node_modules/laterdog/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/dog/.laterdog");
    expect(linux?.installed).toBe("/etc/systemd/system/laterdog.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now laterdog");
    const mac = servicePlan("darwin", "/Users/dog/.laterdog", "/Users/dog");
    expect(mac?.installed).toBe("/Users/dog/Library/LaunchAgents/com.laterdog.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });
});
