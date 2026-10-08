import { describe, expect, it } from "vitest";
import {
  allocatePort,
  applySignIn,
  assertSlug,
  caddySite,
  createPlan,
  deletePlan,
  describeSteps,
  emptyRegistry,
  fenceRules,
  fenceUnit,
  fleetLayout,
  initPlan,
  initialConfig,
  MANAGED_OPENROUTER,
  instanceEnv,
  parseRegistry,
  resumePlan,
  suspendPlan,
  templateUnit,
  upgradePlan,
  type FleetStep,
  type FleetWorkspace,
} from "./fleet.ts";

const layout = fleetLayout("/");
const now = new Date("2026-09-10T08:00:00Z");
const argvOf = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "run" ? [step.argv.join(" ")] : []));
const writesOf = (steps: FleetStep[]) => steps.flatMap((step) => (step.kind === "write" ? [step.path] : []));

describe("fleet naming", () => {
  it("accepts DNS-label workspace names and refuses the rest", () => {
    for (const ok of ["acme", "globex-2", "a1"]) expect(() => assertSlug(ok)).not.toThrow();
    for (const bad of ["Acme", "-acme", "a", "acme_inc", "a".repeat(32), "acme.co", "../etc"]) expect(() => assertSlug(bad)).toThrow("not a workspace name");
  });

  it("allocates loopback ports in strides and skips ones already taken", () => {
    const registry = emptyRegistry("agentada.cc");
    expect(allocatePort(registry)).toEqual({ port: 8810, next: 8820 });
    registry.workspaces.acme = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" };
    registry.nextPort = 8810;
    expect(allocatePort(registry)).toEqual({ port: 8820, next: 8830 });
    expect(() => parseRegistry('{"version":2}')).toThrow("registry");
    expect(parseRegistry(JSON.stringify(registry)).workspaces.acme?.port).toBe(8810);
  });
});

describe("rendered files", () => {
  it("renders one template unit for every workspace, hardened and parameterised by slug", () => {
    const unit = templateUnit({ node: "/usr/bin/node", script: "/usr/lib/node_modules/laterdog/cli.js", layout });
    expect(unit).toContain("User=laterdog-%i");
    expect(unit).toContain("EnvironmentFile=/etc/laterdog/instances/%i.env");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/laterdog/cli.js serve --port ${LATERDOG_SERVER_PORT} --data-dir ${LATERDOG_HOME} --public-url ${LATERDOG_PUBLIC_URL} --label %i --no-pair");
    for (const line of ["PrivateTmp=yes", "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/var/lib/laterdog/%i"]) expect(unit).toContain(line);
    expect(templateUnit({ node: "/usr/bin/node", script: "/src/server/cli.ts", layout })).toContain("--experimental-strip-types /src/server/cli.ts");
  });

  it("requires the loopback fence to start successfully before every tenant instance", () => {
    const unit = templateUnit({ node: "/usr/bin/node", script: "/src/server/laterdog.ts", layout });
    const header = unit.split("[Service]")[0];
    expect(header).toContain("After=network-online.target laterdog-fence.service\n");
    expect(header).toContain("Requires=laterdog-fence.service\n");
    const fence = fenceUnit(layout);
    expect(fence).toContain("Type=oneshot\nRemainAfterExit=yes\nExecStart=/usr/sbin/nft -f /etc/laterdog/fence.nft\n");
    expect(fence).not.toContain("Before=laterdog@.service");
  });

  it("fences each workspace's loopback ports to its own user, Caddy and root", () => {
    const rules = fenceRules([
      { slug: "globex", host: "globex.x", port: 8820, webhookPort: 8821, status: "running", createdAt: "" },
      { slug: "acme", host: "acme.x", port: 8810, webhookPort: 8811, status: "running", createdAt: "" },
    ]);
    expect(rules).toContain("add table inet laterdog\nflush table inet laterdog");
    expect(rules.indexOf("laterdog-acme")).toBeLessThan(rules.indexOf("laterdog-globex"));
    expect(rules).toContain("oif lo tcp dport { 8810, 8811 } meta skuid != { laterdog-acme, caddy, root } reject");
    expect(fenceRules([])).not.toContain("reject");
    const incomplete: FleetWorkspace = { slug: "pending", host: "pending.x", port: 8830, webhookPort: 8831, status: "provisioning", createdAt: "" };
    expect(fenceRules([incomplete])).not.toContain("laterdog-pending");
    expect(fenceRules([{ ...incomplete, accountCreated: true }])).toContain("laterdog-pending");
    expect(fenceRules([{ ...incomplete, status: "error", accountCreated: true }])).toContain("laterdog-pending");
    expect(fenceRules([{ ...incomplete, status: "retained" }])).toContain("laterdog-pending");
  });

  it("serves a running workspace and answers 503 for a suspended one", () => {
    const running = caddySite({ host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running" });
    expect(running).toContain("acme.agentada.cc {");
    expect(running).toContain("reverse_proxy 127.0.0.1:8811");
    expect(running).toContain("reverse_proxy 127.0.0.1:8810 {");
    expect(running).toContain("flush_interval -1");
    expect(caddySite({ host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "suspended" })).toContain('respond "This workspace is suspended." 503');
    for (const status of ["provisioning", "error", "retained"] as const) {
      expect(caddySite({ host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status })).toContain("503");
    }
  });

  it("writes the environment, the first config and the sign-in edits the server reads live", () => {
    const workspace: FleetWorkspace = { slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: "" };
    expect(instanceEnv({ workspace, dataDir: "/var/lib/laterdog/acme/.laterdog", licenseKey: "ld1.k" })).toBe(
      "LATERDOG_HOME=/var/lib/laterdog/acme/.laterdog\nLATERDOG_SERVER_PORT=8810\nLATERDOG_WEBHOOK_PORT=8811\nLATERDOG_PUBLIC_URL=https://acme.agentada.cc\nLATERDOG_LICENSE_KEY=ld1.k\n",
    );
    expect(JSON.parse(initialConfig({ admins: ["ada@example.test"], members: ["@acme.test"], anthropicKey: "sk-ant-x", monthlyCapUsd: 50 }))).toEqual({
      signIn: { admins: ["ada@example.test"], members: ["@acme.test"] }, anthropic: { key: "sk-ant-x" }, budgets: { monthlyUsd: 50 },
    });
    const added = applySignIn('{"anthropic":{"key":"k"},"signIn":{"admins":["ada@example.test"]}}', "add", "Bob@Acme.test", true);
    expect(JSON.parse(added.config)).toEqual({ anthropic: { key: "k" }, signIn: { admins: ["ada@example.test"], members: ["bob@acme.test"] } });
    expect(added.summary).toContain("chat and approvals");
    const removed = applySignIn(added.config, "remove", "bob@acme.test", false);
    expect(JSON.parse(removed.config).signIn).toEqual({ admins: ["ada@example.test"], members: [] });
    expect(removed.summary).toContain("existing email sessions are rechecked");
    expect(() => applySignIn(added.config, "remove", "nobody@acme.test", false)).toThrow("not on the list");
    expect(() => applySignIn("{}", "add", "not an email", false)).toThrow("email");
    const promoted = applySignIn(added.config, "add", "bob@acme.test", false);
    expect(JSON.parse(promoted.config).signIn).toEqual({ admins: ["ada@example.test", "bob@acme.test"], members: [] });
    const demoted = applySignIn(promoted.config, "add", "ada@example.test", true);
    expect(JSON.parse(demoted.config).signIn).toEqual({ admins: ["bob@acme.test"], members: ["ada@example.test"] });
    expect(() => applySignIn(demoted.config, "add", "bob@acme.test", true)).toThrow("at least one admin");
    expect(() => applySignIn(demoted.config, "remove", "bob@acme.test", false)).toThrow("at least one admin");
  });
});

describe("plans", () => {
  it("initialises the server once: folders, registry, templates, fence, the Caddy import, and reloads", () => {
    const { steps, registry } = initPlan({ domain: "AgentAda.cc", node: "/usr/bin/node", script: "/usr/lib/node_modules/laterdog/cli.js", layout });
    expect(registry).toEqual({ version: 1, domain: "agentada.cc", nextPort: 8810, workspaces: {} });
    expect(writesOf(steps)).toEqual(["/etc/laterdog/fleet.json", "/etc/systemd/system/laterdog@.service", "/etc/laterdog/fence.nft", "/etc/systemd/system/laterdog-fence.service"]);
    expect(steps.find((step) => step.kind === "append-once")).toEqual({ kind: "append-once", path: "/etc/caddy/Caddyfile", line: "import /etc/caddy/laterdog.d/*.caddy" });
    expect(argvOf(steps)).toEqual(["systemctl daemon-reload", "systemctl enable --now laterdog-fence.service", "systemctl reload caddy"]);
    expect(() => initPlan({ domain: "not a domain", node: "n", script: "s", layout })).toThrow("domain name");
    // with an operator, the agent unit is written and started, and the registry remembers who
    const withAgent = initPlan({ domain: "agentada.cc", node: "/usr/bin/node", script: "/usr/lib/node_modules/laterdog/cli.js", operator: "dog", layout });
    expect(withAgent.registry.operator).toBe("dog");
    const agent = withAgent.steps.find((step) => step.kind === "write" && step.path === "/etc/systemd/system/laterdog-fleet.service");
    expect(agent).toMatchObject({ content: expect.stringContaining("fleet agent --socket /run/laterdog/fleet.sock --group dog") });
    expect(agent).toMatchObject({ content: expect.stringContaining("RuntimeDirectory=laterdog") });
    expect(argvOf(withAgent.steps)).toContain("systemctl enable --now laterdog-fleet.service");
    expect(() => initPlan({ domain: "agentada.cc", node: "n", script: "s", operator: "Not A User", layout })).toThrow("Unix user");
  });

  it("creates a workspace as its own account with private data, a fenced port, a unit and a site", () => {
    const registry = emptyRegistry("agentada.cc");
    const plan = createPlan({ registry, slug: "acme", seed: { admins: ["ada@example.test"], members: [] }, licenseKey: "ld1.k", memoryMax: "1G", now, layout });
    expect(plan.workspace).toEqual({ slug: "acme", host: "acme.agentada.cc", port: 8810, webhookPort: 8811, status: "running", createdAt: now.toISOString() });
    expect(plan.registry.nextPort).toBe(8820);
    const checkpoints = plan.steps.flatMap((step) => step.kind === "write" && step.path === layout.registryFile ? [JSON.parse(step.content)] : []);
    expect(checkpoints.map((checkpoint) => checkpoint.workspaces.acme)).toEqual([
      { ...plan.workspace, status: "provisioning", accountCreated: false },
      { ...plan.workspace, status: "provisioning", accountCreated: true },
      plan.workspace,
    ]);
    expect(plan.steps[0]).toMatchObject({ kind: "write", path: layout.registryFile });
    expect(plan.steps[1]).toMatchObject({ kind: "run", argv: expect.arrayContaining(["useradd"]) });
    expect(plan.steps[2]).toMatchObject({ kind: "write", path: layout.registryFile });
    expect(checkpoints.every((checkpoint) => checkpoint.nextPort === 8820)).toBe(true);
    expect(argvOf(plan.steps)).toEqual([
      "useradd --system --create-home --home-dir /var/lib/laterdog/acme --shell /usr/sbin/nologin --user-group laterdog-acme",
      "nft -f /etc/laterdog/fence.nft",
      "systemctl daemon-reload",
      "systemctl enable --now laterdog@acme.service",
      "systemctl reload caddy",
    ]);
    const config = plan.steps.find((step) => step.kind === "write" && step.path.endsWith("/acme/.laterdog/config.json"));
    expect(config).toMatchObject({ mode: 0o600, owner: "laterdog-acme" });
    const env = plan.steps.find((step) => step.kind === "write" && step.path === "/etc/laterdog/instances/acme.env");
    expect(env).toMatchObject({ mode: 0o600 });
    // root keeps the environment file: it carries the licence key
    expect(env).not.toHaveProperty("owner");
    expect(plan.steps.find((step) => step.kind === "write" && step.path.endsWith("limits.conf"))).toMatchObject({ content: "[Service]\nMemoryMax=1G\n" });
    expect(plan.steps.find((step) => step.kind === "health")).toMatchObject({ url: "http://127.0.0.1:8810/api/health" });
    // the health wait sits between starting the unit and exposing it through Caddy
    const sequence = plan.steps.flatMap((step) => (step.kind === "run" ? [step.argv[0] === "systemctl" ? step.argv.slice(0, 2).join(" ") : step.argv[0]] : step.kind === "health" ? ["health"] : []));
    expect(sequence).toEqual(["useradd", "nft", "systemctl daemon-reload", "systemctl enable", "health", "systemctl reload"]);
    expect(plan.steps.at(-1)).toMatchObject({ kind: "note", text: expect.stringContaining("https://acme.agentada.cc is ready") });
    expect(() => createPlan({ registry: plan.registry, slug: "acme", seed: { admins: ["x@y.test"], members: [] }, layout })).toThrow("already exists");
    expect(() => createPlan({ registry, slug: "beta", seed: { admins: [], members: [] }, layout })).toThrow("at least one admin");
    expect(() => createPlan({ registry, slug: "beta", seed: { admins: ["x@y.test"], members: [] }, memoryMax: "lots", layout })).toThrow("--memory");
  });

  it("suspends, resumes, deletes and upgrades with the registry kept in step", () => {
    const created = createPlan({ registry: emptyRegistry("agentada.cc"), slug: "acme", seed: { admins: ["a@b.test"], members: [] }, now, layout });
    const suspended = suspendPlan({ registry: created.registry, slug: "acme", layout });
    expect(suspended.registry.workspaces.acme?.status).toBe("suspended");
    expect(argvOf(suspended.steps)).toEqual(["systemctl disable --now laterdog@acme.service", "systemctl reload caddy"]);
    expect(suspended.steps.find((step) => step.kind === "write" && step.path.endsWith("acme.caddy"))).toMatchObject({ content: expect.stringContaining("503") });
    const resumed = resumePlan({ registry: suspended.registry, slug: "acme", layout });
    expect(resumed.registry.workspaces.acme?.status).toBe("running");
    expect(argvOf(resumed.steps)).toEqual(["systemctl enable --now laterdog@acme.service", "systemctl reload caddy"]);
    const kept = deletePlan({ registry: resumed.registry, slug: "acme", keepData: true, layout });
    expect(kept.registry.workspaces.acme).toMatchObject({ status: "retained", port: 8810 });
    expect(argvOf(kept.steps).some((argv) => argv.startsWith("userdel"))).toBe(false);
    expect(argvOf(deletePlan({ registry: resumed.registry, slug: "acme", keepData: false, layout }).steps)).toContain("userdel --remove laterdog-acme");
    expect(() => deletePlan({ registry: kept.registry, slug: "acme", keepData: true, layout })).toThrow("operator recovery");
    expect(() => createPlan({ registry: kept.registry, slug: "acme", seed: { admins: ["a@b.test"], members: [] }, layout })).toThrow("already exists");
    expect(fenceRules(Object.values(kept.registry.workspaces))).toContain("laterdog-acme");
    for (const status of ["provisioning", "error", "retained"] as const) {
      const incomplete = { ...created.registry, workspaces: { acme: { ...created.workspace, status } } };
      expect(() => resumePlan({ registry: incomplete, slug: "acme", layout })).toThrow("operator recovery");
      expect(() => suspendPlan({ registry: incomplete, slug: "acme", layout })).toThrow("operator recovery");
      expect(() => deletePlan({ registry: incomplete, slug: "acme", keepData: false, layout })).toThrow("operator recovery");
    }
    const two = createPlan({ registry: created.registry, slug: "globex", seed: { admins: ["g@x.test"], members: [] }, now, layout }).registry;
    expect(argvOf(upgradePlan({ registry: suspendPlan({ registry: two, slug: "globex", layout }).registry }))).toEqual(["npm install -g laterdog@latest", "systemctl restart laterdog@acme.service"]);
  });

  it("seeds only the trusted portal gateway and reserves the portal hostname", () => {
    const registry = emptyRegistry("example.test");
    const seed = { admins: ["owner@example.test"], members: [], portalUrl: "https://admin.example.test", anthropicUrl: "https://admin.example.test/api/gateway/acme/anthropic", anthropicKey: "workspace-scoped-token" };
    const plan = createPlan({ registry, slug: "acme", seed, now, layout });
    const env = plan.steps.find((step) => step.kind === "write" && step.path.endsWith("/acme.env"));
    expect(env).toMatchObject({ mode: 0o600, content: expect.stringContaining("LATERDOG_ADMIN_URL=https://admin.example.test\nLATERDOG_ADMIN_WORKSPACE=acme") });
    expect(env).not.toHaveProperty("owner");
    const config = plan.steps.find((step) => step.kind === "write" && step.path.endsWith("/config.json"));
    expect(config).toMatchObject({ owner: "laterdog-acme", content: expect.stringContaining('"url": "https://admin.example.test/api/gateway/acme/anthropic"') });
    for (const portalUrl of ["http://admin.example.test", "https://admin.example.test/", "https://user:secret@admin.example.test", "https://admin.example.test/path"]) {
      expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, portalUrl }, layout })).toThrow("HTTPS origin");
    }
    expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, anthropicUrl: "https://other.example.test" }, layout })).toThrow("workspace's portal gateway");
    expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, portalUrl: undefined }, layout })).toThrow("requires portalUrl");
    expect(() => createPlan({ registry, slug: "admin", seed, layout })).toThrow("reserved for the admin portal");
  });

  it("renders privileged steps but never recommends root writes through tenant paths", () => {
    const lines = describeSteps([
      { kind: "mkdir", path: "/var/lib/laterdog/acme/.laterdog", mode: 0o700, owner: "laterdog-acme" },
      { kind: "write", path: "/var/lib/laterdog/acme/.laterdog/config.json", content: "secret", mode: 0o600, owner: "laterdog-acme" },
      { kind: "write", path: "/etc/laterdog/instances/acme.env", content: "LATERDOG_SERVER_PORT=8810\n", mode: 0o600 },
      { kind: "run", argv: ["useradd", "--comment", "Acme Inc", "laterdog-acme"], why: "the account" },
      { kind: "append-once", path: "/etc/caddy/Caddyfile", line: "import /etc/caddy/laterdog.d/*.caddy" },
      { kind: "note", text: "done" },
    ]);
    expect(lines).toEqual([
      "# Create /var/lib/laterdog/acme/.laterdog mode 700 as laterdog-acme (use fleet --yes; never root chown on tenant paths)",
      "# Write /var/lib/laterdog/acme/.laterdog/config.json mode 600 as laterdog-acme (use fleet --yes; tenant content omitted)",
      "cat > /etc/laterdog/instances/acme.env <<'LATERDOG_EOF'",
      "LATERDOG_SERVER_PORT=8810",
      "LATERDOG_EOF",
      "chmod 600 /etc/laterdog/instances/acme.env",
      "useradd --comment 'Acme Inc' laterdog-acme   # the account",
      "grep -qxF 'import /etc/caddy/laterdog.d/*.caddy' /etc/caddy/Caddyfile || printf '\\n%s\\n' 'import /etc/caddy/laterdog.d/*.caddy' >> /etc/caddy/Caddyfile",
      "# done",
    ]);
  });

  it("seeds private agentful OpenRouter config, including an empty catalog for later assignments", () => {
    const seed = { admins: ["owner@example.test"], members: [], portalUrl: "https://admin.example.test", openrouterKey: "workspace-scoped-token", openrouterUrl: "https://admin.example.test/api/gateway/acme/openrouter/v1", openrouterModels: ["anthropic/claude-sonnet-4"], openrouterDefault: true };
    const registry = emptyRegistry("example.test");
    const plan = createPlan({ registry, slug: "acme", seed, layout });
    const config = plan.steps.find((step) => step.kind === "write" && step.path.endsWith("/opencode.json"));
    expect(config).toMatchObject({ owner: "laterdog-acme", mode: 0o600 });
    expect(config?.kind === "write" && JSON.parse(config.content)).toEqual({ provider: { [MANAGED_OPENROUTER]: {
      npm: "@ai-sdk/openai-compatible", name: "Managed OpenRouter",
      options: { baseURL: seed.openrouterUrl, apiKey: seed.openrouterKey }, models: { "anthropic/claude-sonnet-4": { name: "anthropic/claude-sonnet-4" } },
    } } });
    expect(plan.steps.filter((step) => step.kind === "mkdir" && step.path.includes("/.config"))).toEqual([
      { kind: "mkdir", path: "/var/lib/laterdog/acme/.config", mode: 0o700, owner: "laterdog-acme" },
      { kind: "mkdir", path: "/var/lib/laterdog/acme/.config/opencode", mode: 0o700, owner: "laterdog-acme" },
    ]);
    expect(JSON.parse(initialConfig(seed)).defaultModelSelection).toEqual({ instanceId: "opencodeGo", model: `${MANAGED_OPENROUTER}/anthropic/claude-sonnet-4` });
    expect(JSON.parse(initialConfig({ ...seed, openrouterDefault: false, anthropicKey: "other-scoped-token" }))).not.toHaveProperty("defaultModelSelection");
    const empty = createPlan({ registry, slug: "acme", seed: { ...seed, openrouterModels: [], openrouterDefault: false }, layout });
    const emptyConfig = empty.steps.find((step) => step.kind === "write" && step.path.endsWith("/opencode.json"));
    expect(emptyConfig?.kind === "write" && JSON.parse(emptyConfig.content).provider[MANAGED_OPENROUTER].models).toEqual({});
    for (const openrouterUrl of ["https://evil.example.test/v1", "https://admin.example.test/api/gateway/other/openrouter/v1", `${seed.openrouterUrl}?key=secret`]) {
      expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, openrouterUrl }, layout })).toThrow("workspace's portal gateway");
    }
    expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, portalUrl: undefined }, layout })).toThrow("workspace's portal gateway");
    expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, openrouterModels: [] }, layout })).toThrow("requires a model assignment");
    for (const openrouterModels of [["bad\nmodel"], Array(101).fill("provider/model")]) expect(() => createPlan({ registry, slug: "acme", seed: { ...seed, openrouterModels }, layout })).toThrow("valid model IDs");
  });
});
