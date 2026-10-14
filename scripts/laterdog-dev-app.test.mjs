import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync as readFile, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { installDevUpdateConfig, packagesDevVariant } from "./dev-update-config.mjs";
import { parse } from "yaml";
import { LIVE_DATA_FLAG, SCRIPT_DEFAULTS } from "../electron/app-variant.mjs";
import { banner, planCommand, safeTarget, scriptEnvironment, withoutLiveFlag } from "./dev-safe.mjs";
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

describe("the dev scripts", () => {
  it("run on isolated data and ports unless told otherwise", () => {
    const target = safeTarget({ argv: [], env: {}, home: HOME });
    expect(target).toMatchObject({ live: false, home: join(HOME, SCRIPT_DEFAULTS.dataDirName), serverPort: 9011, supervisorPort: 9111 });
    const environment = scriptEnvironment(target, { PATH: "/bin", LATERDOG_URL: "http://127.0.0.1:8799" }, HOME);
    expect(environment).toMatchObject({ LATERDOG_HOME: "/Users/someone/.laterdog-dev-scripts", LATERDOG_SERVER_PORT: "9011", LATERDOG_PORT: "9111", LATERDOG_BRIDGE_DIR: "/Users/someone/.laterdog-dev-scripts/bridge" });
    expect(environment.LATERDOG_URL).toBeUndefined();
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
    expect(read("scripts/laterdog.mjs")).toContain("safeTarget()");
    expect(read("vite.config.ts")).not.toContain("|| 8799");
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
