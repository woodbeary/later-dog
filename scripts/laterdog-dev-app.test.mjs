import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync as readFile, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { installDevUpdateConfig, keepOnlyDevScheme, packagesDevVariant } from "./dev-update-config.mjs";
import { parse } from "yaml";
import { LIVE_DATA_FLAG, SCRIPT_DEFAULTS } from "../electron/app-variant.mjs";
import { ISOLATED_DELETIONS, banner, commandContext, planCommand, safeTarget, scriptEnvironment, withoutLiveFlag } from "./dev-safe.mjs";
import { companionDefaults } from "../companion/src/variant.ts";
import { appVariantSuffix, sharedVmViewerPort } from "../server/variant-names.ts";
import { DEV_BUILDER_CONFIG, DEV_RELEASE_TAG, DEV_ZIP_NAME, builderArguments, devAppPath, devFeedUrl, devNotes, devReleaseFiles, devVersion } from "./laterdog-dev-build.mjs";
import { devIconSamples, sheetHtml, SHEET_SIZES } from "./laterdog-dev-icons.mjs";
import { VARIANT_SERVER_PORTS } from "./mcp-server.ts";
import { describeVariant } from "../electron/app-variant.mjs";

const read = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const HOME = "/Users/someone";

describe("the Dev build", () => {
  it("numbers each build above the last and above the release it grew from", () => {
    expect(devVersion("0.3.27", 41)).toBe("0.3.27-dev.41");
    expect(() => devVersion("0.3.27-beta", 1)).toThrow(/not X\.Y\.Z/);
    expect(() => devVersion("0.3.27", "latest")).toThrow(/run number/);
  });

  it("builds only the Dev variant from the Dev config and bakes its identity into package.json", () => {
    expect(builderArguments("release")).toEqual([]);
    expect(builderArguments("dev", { version: "0.3.27-dev.41" })).toEqual(["--config", DEV_BUILDER_CONFIG, "-c.extraMetadata.laterdogVariant=dev", "-c.extraMetadata.version=0.3.27-dev.41"]);
    expect(devAppPath()).toBe("release/mac-arm64/later.dog Dev.app");
  });

  it("writes a dev-mac.yml that points at the rolling prerelease, never the release feed", () => {
    expect(devFeedUrl("woodbeary/later-dog")).toBe(`https://github.com/woodbeary/later-dog/releases/download/${DEV_RELEASE_TAG}/`);
    const files = devReleaseFiles({
      version: "0.3.27-dev.41", repository: "woodbeary/later-dog", zipBytes: Buffer.from("zip"), diskImageName: "later.dog-Dev-macOS-arm64.dmg",
      diskImageBytes: Buffer.from("dmg"), releaseDate: "2026-10-14T00:00:00.000Z", notes: devNotes({ sha: "0123456789abcdef", subject: "Fix a thing" }),
    });
    expect(Object.keys(files).sort()).toEqual(["NOTES.md", "SHA256SUMS.txt", "dev-mac.yml"]);
    const feed = parse(files["dev-mac.yml"]);
    expect(feed.version).toBe("0.3.27-dev.41");
    expect(feed.files[0].url).toBe(`https://github.com/woodbeary/later-dog/releases/download/dev-latest/${DEV_ZIP_NAME}`);
    expect(files["dev-mac.yml"]).not.toContain("releases/latest");
    expect(files["SHA256SUMS.txt"]).toContain(DEV_ZIP_NAME);
    expect(files["NOTES.md"]).toContain("Dev build of 012345678: Fix a thing");
  });

  it("keeps the workflow on the dev branch, with the release's secrets by name and nothing new", () => {
    const dev = parse(read(".github/workflows/dev-app.yml"));
    expect(dev.on).toEqual({ push: { branches: ["dev"] } });
    expect(dev.jobs.package.env.LATERDOG_VARIANT).toBe("dev");
    const secrets = (text) => new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]));
    const used = secrets(read(".github/workflows/dev-app.yml"));
    const allowed = secrets(read(".github/workflows/macos.yml"));
    expect([...used].filter((name) => !allowed.has(name))).toEqual([]);
    expect(used.has("MAC_DEVELOPER_ID_P12") && used.has("APPLE_API_KEY_P8")).toBe(true);
    const text = read(".github/workflows/dev-app.yml");
    expect(text).toContain("releases/download/dev-latest/");
    expect(text).not.toContain("releases/latest/download");
    expect(text).toContain("--prerelease");
    expect(text).toContain("dog.later.app.dev");
    expect(text).toContain("test \"$SCHEME\" != 'laterdog'");
    expect(text).toContain("test \"$SCHEMES\" = 'laterdog-dev'");
  });
});

describe("the Dev update cache", () => {
  it("replaces the release's app-update.yml only when the Dev app is being packed", async () => {
    const resources = mkdtempSync(join(tmpdir(), "laterdog-dev-update-"));
    try {
      writeFileSync(join(resources, "app-update.yml"), "updaterCacheDirName: laterdog-updater\n");
      expect(await installDevUpdateConfig({ packager: { appInfo: { id: "dog.later.app" } } }, resources)).toBe(false);
      expect(readFile(join(resources, "app-update.yml"), "utf8")).toBe("updaterCacheDirName: laterdog-updater\n");
      expect(await installDevUpdateConfig({}, resources)).toBe(false);
      expect(packagesDevVariant({ packager: { config: { appId: "dog.later.app.dev" } } })).toBe(true);
      expect(await installDevUpdateConfig({ packager: { appInfo: { id: "dog.later.app.dev" } } }, resources)).toBe(true);
      expect(readFile(join(resources, "app-update.yml"), "utf8")).toBe("updaterCacheDirName: laterdog-dev-updater\n");
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

describe("the Dev app's URL schemes", () => {
  it.skipIf(process.platform !== "darwin")("lose the release's scheme from Info.plist before signing", async () => {
    const out = mkdtempSync(join(tmpdir(), "laterdog-dev-plist-"));
    try {
      const contents = join(out, "later.dog Dev.app", "Contents");
      mkdirSync(contents, { recursive: true });
      const json = join(out, "info.json");
      writeFileSync(json, JSON.stringify({ CFBundleIdentifier: "dog.later.app.dev", CFBundleURLTypes: [{ CFBundleURLName: "a", CFBundleURLSchemes: ["laterdog"] }, { CFBundleURLName: "b", CFBundleURLSchemes: ["laterdog-dev"] }] }));
      execFileSync("plutil", ["-convert", "xml1", "-o", join(contents, "Info.plist"), json]);
      const context = { appOutDir: out, electronPlatformName: "darwin", packager: { appInfo: { id: "dog.later.app.dev", productFilename: "later.dog Dev" } } };
      expect(await keepOnlyDevScheme({ ...context, packager: { appInfo: { id: "dog.later.app", productFilename: "later.dog Dev" } } })).toBe(false);
      expect(await keepOnlyDevScheme(context)).toBe(true);
      const after = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")], { encoding: "utf8" }));
      expect(after.CFBundleURLTypes.flatMap((entry) => entry.CFBundleURLSchemes)).toEqual(["laterdog-dev"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("are stripped by the after-pack hook the release build also runs", () => {
    expect(read("scripts/after-pack.mjs")).toContain("await keepOnlyDevScheme(context);");
  });
});

describe("the dev scripts", () => {
  it("run on isolated data and ports unless told otherwise", () => {
    const target = safeTarget({ argv: [], env: {}, home: HOME });
    expect(target).toMatchObject({ live: false, home: join(HOME, SCRIPT_DEFAULTS.dataDirName), serverPort: 9011, supervisorPort: 9111 });
    const environment = scriptEnvironment(target, { PATH: "/bin", LATERDOG_URL: "http://127.0.0.1:8799" }, HOME);
    expect(environment).toMatchObject({ LATERDOG_HOME: "/Users/someone/.laterdog-dev-scripts", LATERDOG_SERVER_PORT: "9011", LATERDOG_PORT: "9111", LATERDOG_BRIDGE_DIR: "/Users/someone/.laterdog-dev-scripts/bridge" });
    expect(environment.LATERDOG_URL).toBeUndefined();
    expect(environment.LATERDOG_APP_VARIANT).toBe("dev");
  });

  it("drop every variable that could point a dev script back at the live supervisor, tools, companion or harness", () => {
    expect(ISOLATED_DELETIONS).toEqual(expect.arrayContaining(["LATERDOG_SUPERVISOR_URL", "LATERDOG_TOKEN_FILE", "LATERDOG_DATA_DIR", "LATERDOG_HARNESS_URL", "LATERDOG_COMPANION_DIR", "LATERDOG_WEBHOOK_PORT"]));
    const target = safeTarget({ argv: [], env: {}, home: HOME });
    const leaked = Object.fromEntries(ISOLATED_DELETIONS.map((name) => [name, "live"]));
    const environment = scriptEnvironment(target, { ...leaked, KEEP: "1" });
    for (const name of ISOLATED_DELETIONS) expect(environment[name]).toBeUndefined();
    expect(environment.KEEP).toBe("1");
    const live = safeTarget({ argv: [LIVE_DATA_FLAG], env: {}, home: HOME });
    expect(scriptEnvironment(live, { LATERDOG_SUPERVISOR_URL: "http://127.0.0.1:9010" }).LATERDOG_SUPERVISOR_URL).toBe("http://127.0.0.1:9010");
  });

  it("leave the person's own tools (mcp, bridge, doctor, login, supervisor, github) on the release defaults", () => {
    for (const command of ["mcp", "bridge", "doctor", "login", "supervisor", "github"]) {
      const context = commandContext(command, { argv: [], env: { PATH: "/bin" }, home: HOME });
      expect(context).toMatchObject({ isolated: false, target: null, dataRoot: "/Users/someone/.laterdog", supervisorUrl: "http://127.0.0.1:9010", env: { PATH: "/bin" } });
    }
    expect(commandContext("login", { argv: [], env: { LATERDOG_HOME: "/Users/someone/.laterdog", LATERDOG_SUPERVISOR_URL: "http://127.0.0.1:9010" }, home: HOME }).env.LATERDOG_SUPERVISOR_URL).toBe("http://127.0.0.1:9010");
    const dev = commandContext("dev", { argv: [], env: {}, home: HOME });
    expect(dev).toMatchObject({ isolated: true, dataRoot: "/Users/someone/.laterdog-dev-scripts", supervisorUrl: "http://127.0.0.1:9111" });
    expect(() => commandContext("dev", { argv: [], env: { LATERDOG_HOME: "/Users/someone/.laterdog" }, home: HOME })).toThrow(/released later\.dog app/);
  });

  it("point pnpm dev, dev:server and dev:desktop at that target", () => {
    const target = safeTarget({ argv: [], env: {}, home: HOME });
    expect(planCommand("ui", target, [], {}).environment).toEqual({ LATERDOG_SERVER_PORT: "9011", LATERDOG_UI_PORT: "5199" });
    expect(planCommand("server", target).environment).toEqual({ LATERDOG_SERVER_PORT: "9011" });
    const desktop = planCommand("desktop", target);
    expect(desktop.environment.LATERDOG_VARIANT).toBe("dev");
    expect(desktop.steps).toHaveLength(2);
    expect(() => planCommand("everything", target)).toThrow();
  });

  it("refuse the live app's data and ports", () => {
    expect(() => safeTarget({ argv: [], env: { LATERDOG_HOME: join(HOME, ".laterdog") }, home: HOME })).toThrow(/released later\.dog app/);
    expect(() => safeTarget({ argv: [], env: { LATERDOG_SERVER_PORT: "8799" }, home: HOME })).toThrow(new RegExp(LIVE_DATA_FLAG));
  });

  it("reach live data only through the loudly named flag, and say so on screen", () => {
    const target = safeTarget({ argv: ["node", "dev-safe", LIVE_DATA_FLAG], env: {}, home: HOME });
    expect(target.live).toBe(true);
    expect(target.home).toBe(join(HOME, ".laterdog"));
    expect(banner(target)).toContain("LIVE later.dog data");
    expect(banner(target)).toContain(LIVE_DATA_FLAG);
    expect(planCommand("server", target).environment.LATERDOG_SERVER_PORT).toBe("8799");
    expect(planCommand("desktop", target).environment.LATERDOG_VARIANT).toBe("release");
    expect(withoutLiveFlag(["a", LIVE_DATA_FLAG, "b"])).toEqual(["a", "b"]);
    expect(banner(safeTarget({ argv: [], env: {}, home: homedir() }), homedir())).toContain("isolated data");
  });

  it("are what package.json actually runs", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts.dev).toBe("node scripts/dev-safe.mjs ui");
    expect(scripts["dev:server"]).toBe("node scripts/dev-safe.mjs server");
    expect(scripts["dev:desktop"]).toBe("node scripts/dev-safe.mjs desktop");
    expect(scripts["laterdog:dev"]).toBe("node scripts/laterdog.mjs dev");
    expect(read("scripts/laterdog.mjs")).toContain("commandContext(command)");
    expect(read("vite.config.ts")).not.toContain("|| 8799");
    expect(read("vite.config.ts")).toContain('command === "serve" && devTarget.refusal');
  });

  it("let the MCP client find the Dev app's ports the way the app declares them", () => {
    expect([...VARIANT_SERVER_PORTS.release]).toEqual([...describeVariant("release").ports.server]);
    expect([...VARIANT_SERVER_PORTS.dev]).toEqual([...describeVariant("dev").ports.server]);
  });
});

describe("the Dev icon", () => {
  const release = read("public/app-icon.svg");
  const samples = devIconSamples(release);

  it("offers three samples that each differ from the release icon and from each other", () => {
    expect(samples).toHaveLength(3);
    expect(new Set([release, ...samples.map((sample) => sample.svg)]).size).toBe(4);
    for (const sample of samples) expect(sample.svg.startsWith("<svg") && sample.svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("wires the first sample in as the placeholder", () => {
    expect(read("public/app-icon-dev.svg")).toBe(samples[0].svg);
  });

  it("lays the sheet out at 16, 32, 128 and 512 pixels for every sample", () => {
    expect(SHEET_SIZES).toEqual([16, 32, 128, 512]);
    const html = sheetHtml(release, samples);
    for (const size of SHEET_SIZES) expect(html.match(new RegExp(`width="${size}" height="${size}"`, "g"))?.length).toBe(4);
  });
});

describe("the phone companion, the local computer and the supervisor", () => {
  it("keep the release's companion ports and folder, and give Dev its own", () => {
    expect(companionDefaults({}, HOME)).toEqual({ companionPort: 8810, controlPort: 8811, dataDir: "/Users/someone/.laterdog-companion" });
    expect(companionDefaults({ LATERDOG_APP_VARIANT: "dev" }, HOME)).toEqual({ companionPort: 8910, controlPort: 8909, dataDir: "/Users/someone/.laterdog-dev/companion" });
    const dev = describeVariant("dev");
    const release = describeVariant("release");
    expect(companionDefaults({ LATERDOG_VARIANT: "dev" }, HOME)).toMatchObject({ companionPort: dev.ports.companion, controlPort: dev.ports.companionControl });
    expect(companionDefaults({}, HOME)).toMatchObject({ companionPort: release.ports.companion, controlPort: release.ports.companionControl });
    expect(read("electron/companion.mjs")).toContain("variant.ports.companionControl");
  });

  it("name the local computer's container and viewer port per variant, the release's unchanged", () => {
    expect(appVariantSuffix({})).toBe("");
    expect(appVariantSuffix({ LATERDOG_APP_VARIANT: "dev" })).toBe("-dev");
    expect(appVariantSuffix({ LATERDOG_APP_VARIANT: "release" })).toBe("");
    expect(sharedVmViewerPort({})).toBe(6080);
    expect(sharedVmViewerPort({ LATERDOG_APP_VARIANT: "dev" })).toBe(6180);
    expect(read("server/container-computer.ts")).toContain("laterdog-computer${appVariantSuffix()}");
  });

  it("never changes the environment the release's supervisor starts with", async () => {
    const spawned = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ spawn: (...call) => { spawned.push(call); return { stdout: { on() {} }, stderr: { on() {} }, on() {} }; } }));
    vi.stubEnv("LATERDOG_PORT", "1234");
    const resourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/unused-resources", configurable: true });
    try {
      const { startLaterDogSupervisor } = await import("../electron/laterdog-supervisor.mjs");
      const directory = mkdtempSync(join(tmpdir(), "laterdog-supervisor-env-"));
      try {
        await startLaterDogSupervisor({ app: { isPackaged: true }, dataDir: directory, port: 8799, ownerToken: "t", log: () => {} });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      expect(spawned).toHaveLength(1);
      expect(spawned[0][2].env.LATERDOG_PORT).toBe("1234");
    } finally {
      if (resourcesPath) Object.defineProperty(process, "resourcesPath", resourcesPath);
      else delete process.resourcesPath;
      vi.unstubAllEnvs();
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
