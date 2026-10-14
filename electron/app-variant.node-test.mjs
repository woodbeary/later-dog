import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEV,
  LIVE_DATA_ENV,
  LIVE_DATA_FLAG,
  RELEASE,
  APP_VARIANT_ENV,
  applyVariantEnvironment,
  bundleIsDev,
  companionDirFor,
  insidePath,
  readBundleIdentifier,
  dataDirFor,
  deepLink,
  deepLinkPattern,
  describeVariant,
  logsDirFor,
  ownedPorts,
  profilesDataDirFor,
  releaseDataDir,
  resolveVariantId,
  safeStorageService,
  scriptTarget,
  serverPortRange,
  tempName,
  userDataDirFor,
  webhookPortFor,
} from "./app-variant.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(directory, "..");
const HOME = "/Users/someone";
const release = describeVariant(RELEASE);
const dev = describeVariant(DEV);

const packaged = (extra = {}) => ({ env: {}, packageJson: {}, execPath: "/Applications/later.dog.app/Contents/MacOS/later.dog", electronVersion: "40.0.0", defaultApp: false, ...extra });

test("a packaged release app is the release variant", () => {
  assert.equal(resolveVariantId(packaged()), RELEASE);
});

test("a packaged Dev app is recognised by its baked identity or its bundle name", () => {
  assert.equal(resolveVariantId(packaged({ packageJson: { laterdogVariant: "dev" } })), DEV);
  assert.equal(resolveVariantId(packaged({ execPath: "/Applications/later.dog Dev.app/Contents/MacOS/later.dog Dev" })), DEV);
  assert.equal(bundleIsDev("/Applications/later.dog Dev.app/Contents/MacOS/later.dog Dev"), true);
  assert.equal(bundleIsDev("/Applications/later.dog.app/Contents/MacOS/later.dog"), false);
});

test("when the two identities disagree the app fails toward Dev, which owns nothing live", () => {
  assert.equal(resolveVariantId(packaged({ packageJson: { laterdogVariant: "release" }, execPath: "/Applications/later.dog Dev.app/Contents/MacOS/later.dog Dev" })), DEV);
  assert.equal(resolveVariantId(packaged({ packageJson: { laterdogVariant: "dev" } })), DEV);
});

test("a packaged app ignores the environment override, so a stray variable cannot turn the release into Dev or back", () => {
  assert.equal(resolveVariantId(packaged({ env: { LATERDOG_VARIANT: "dev" } })), RELEASE);
  assert.equal(resolveVariantId(packaged({ env: { LATERDOG_VARIANT: "release" }, packageJson: { laterdogVariant: "dev" } })), DEV);
});

test("unpackaged Electron (pnpm dev:desktop, electron .) is Dev unless it asks for release by name", () => {
  const unpackaged = { env: {}, packageJson: {}, execPath: "/repo/node_modules/electron/dist/Electron", electronVersion: "40.0.0", defaultApp: true };
  assert.equal(resolveVariantId(unpackaged), DEV);
  assert.equal(resolveVariantId({ ...unpackaged, env: { LATERDOG_VARIANT: "release" } }), RELEASE);
  assert.equal(resolveVariantId({ ...unpackaged, env: { LATERDOG_VARIANT: " DEV " } }), DEV);
});

test("plain Node (tests, scripts) is release unless the override says Dev", () => {
  const node = { env: {}, packageJson: {}, execPath: "/usr/local/bin/node", electronVersion: undefined, defaultApp: false };
  assert.equal(resolveVariantId(node), RELEASE);
  assert.equal(resolveVariantId({ ...node, env: { LATERDOG_VARIANT: "dev" } }), DEV);
});

test("a stray override can never stop a packaged app, and only an unpackaged run is told off for a bad one", () => {
  assert.equal(resolveVariantId(packaged({ env: { LATERDOG_VARIANT: "staging" } })), RELEASE);
  assert.equal(resolveVariantId(packaged({ env: { LATERDOG_VARIANT: "staging" }, packageJson: { laterdogVariant: "dev" } })), DEV);
  assert.throws(() => resolveVariantId({ env: { LATERDOG_VARIANT: "staging" }, packageJson: {}, electronVersion: "40.0.0", defaultApp: true }), /not a later\.dog variant/);
});

test("the bundle identifier in Info.plist also makes a packaged app Dev", () => {
  const plist = (id) => `<plist><dict><key>CFBundleName</key><string>x</string><key>CFBundleIdentifier</key>\n<string>${id}</string></dict></plist>`;
  const execPath = "/Applications/Renamed.app/Contents/MacOS/Renamed";
  assert.equal(readBundleIdentifier(execPath, () => plist("dog.later.app.dev")), "dog.later.app.dev");
  assert.equal(readBundleIdentifier("/usr/bin/node", () => plist("dog.later.app.dev")), null);
  assert.equal(readBundleIdentifier(execPath, () => { throw new Error("unreadable"); }), null);
  assert.equal(resolveVariantId(packaged({ execPath, bundleIdentifier: () => "dog.later.app.dev" })), DEV);
  assert.equal(resolveVariantId(packaged({ execPath, bundleIdentifier: () => "dog.later.app" })), RELEASE);
  assert.equal(resolveVariantId(packaged({ execPath, bundleIdentifier: () => null })), RELEASE);
});

test("an unknown override is an error, never a silent release", () => {
  assert.throws(() => resolveVariantId({ env: { LATERDOG_VARIANT: "staging" }, packageJson: {}, electronVersion: undefined }), /not a later\.dog variant/);
  assert.throws(() => describeVariant("staging"), /Unknown later\.dog variant/);
});

test("the release keeps every name and port it has always had", () => {
  assert.equal(release.productName, "later.dog");
  assert.equal(release.appId, "dog.later.app");
  assert.equal(release.scheme, "laterdog");
  assert.equal(release.userDataDirName, "later.dog");
  assert.equal(release.desktopEntry, "dog.later.app.desktop");
  assert.equal(release.cuaHostBundleId, "dog.later.app");
  assert.equal(release.iconPath, "resources/app-icon.png");
  assert.equal(release.ports.companion, 8810);
  assert.equal(release.ports.companionControl, 8811);
  assert.equal(companionDirFor(release, { env: {}, home: HOME }), null);
  assert.deepEqual([...release.ports.server], [8799, 18799, 28799]);
  assert.deepEqual([...release.ports.companionRelay], [8798, 18798, 28798]);
  assert.equal(release.ports.supervisor, 9010);
  assert.deepEqual({ ...release.ports.profiles }, { first: 8811, last: 8899 });
  assert.equal(release.updates.channel, null);
  assert.equal(release.updates.feedFile, "latest-mac.yml");
  assert.equal(release.updates.cacheDirName, "laterdog-updater");
  assert.equal(webhookPortFor(release, 8799), 8800);
  assert.equal(serverPortRange(release), "8799–28799");
  assert.equal(dataDirFor(release, { env: {}, home: HOME }), "/Users/someone/.laterdog");
  assert.equal(userDataDirFor(release, "/Users/someone/Library/Application Support"), "/Users/someone/Library/Application Support/later.dog");
  assert.equal(logsDirFor(release, { home: HOME, platform: "darwin" }), null);
  assert.equal(deepLink(release, "organization"), "laterdog://organization");
  assert.equal(safeStorageService(release), "later.dog Safe Storage");
});

test("Dev names itself and its data differently in every place the release names itself", () => {
  const appData = "/Users/someone/Library/Application Support";
  const names = (definition) => ({
    productName: definition.productName,
    appId: definition.appId,
    scheme: definition.scheme,
    dataDir: dataDirFor(definition, { env: {}, home: HOME }),
    profilesDir: profilesDataDirFor(definition, { env: {}, home: HOME }),
    userData: userDataDirFor(definition, appData),
    safeStorage: safeStorageService(definition),
    cuaHostId: definition.cuaHostBundleId,
    desktopEntry: definition.desktopEntry,
    tempPrefix: definition.tempPrefix,
    icon: definition.iconPath,
    companionPorts: `${definition.ports.companion}/${definition.ports.companionControl}`,
    companionDir: String(companionDirFor(definition, { env: {}, home: HOME })),
    updaterCache: definition.updates.cacheDirName,
    updaterFeedFile: definition.updates.feedFile,
    protocolHandler: deepLink(definition, "cloud"),
    singleInstanceKey: userDataDirFor(definition, appData),
  });
  const left = names(release);
  const right = names(dev);
  for (const key of Object.keys(left)) assert.notEqual(left[key], right[key], `${key} is shared between the release and Dev`);
  assert.equal(right.dataDir, "/Users/someone/.laterdog-dev");
  assert.equal(right.profilesDir, "/Users/someone/.laterdog-dev-profiles");
  assert.equal(right.productName, "later.dog Dev");
  assert.equal(right.appId, "dog.later.app.dev");
  assert.equal(right.scheme, "laterdog-dev");
  assert.equal(right.safeStorage, "later.dog Dev Safe Storage");
  assert.equal(dev.updates.channel, "dev");
  assert.equal(dev.updates.feedFile, "dev-mac.yml");
  assert.equal(dev.updates.releaseCheck, false);
  assert.equal(tempName(dev, "cloud-move"), "laterdog-dev-cloud-move");
  assert.equal(tempName(release, "cloud-move"), "laterdog-cloud-move");
});

test("Dev's folders never sit inside the release's, and the release's never inside Dev's", () => {
  const inside = (parent, child) => child === parent || child.startsWith(`${parent}/`);
  const releaseDirs = [dataDirFor(release, { env: {}, home: HOME }), profilesDataDirFor(release, { env: {}, home: HOME }), "/Users/someone/.laterdog-v0"];
  const devDirs = [dataDirFor(dev, { env: {}, home: HOME }), profilesDataDirFor(dev, { env: {}, home: HOME })];
  for (const left of releaseDirs) for (const right of devDirs) {
    assert.equal(inside(left, right), false, `${right} is inside ${left}`);
    assert.equal(inside(right, left), false, `${left} is inside ${right}`);
  }
});

test("Dev never takes the release's data folder, even when LATERDOG_HOME names it", () => {
  const own = "/Users/someone/.laterdog-dev";
  for (const live of ["/Users/someone/.laterdog", "/Users/someone/.laterdog/", "/Users/someone/.laterdog/supervisor", "/Users/someone/.laterdog-profiles", "/Users/someone/.laterdog-profiles/p1", "/Users/someone/.laterdog-v0"]) {
    assert.equal(dataDirFor(dev, { env: { LATERDOG_HOME: live }, home: HOME }), own, live);
  }
  assert.equal(dataDirFor(dev, { env: { LATERDOG_HOME: "/tmp/fixture-home" }, home: HOME }), "/tmp/fixture-home");
  assert.equal(dataDirFor(release, { env: { LATERDOG_HOME: "/tmp/fixture-home" }, home: HOME }), "/tmp/fixture-home");
  assert.equal(releaseDataDir(HOME), "/Users/someone/.laterdog");
});

test("Dev logs go to their own folder", () => {
  assert.equal(logsDirFor(dev, { home: HOME, platform: "darwin" }), "/Users/someone/Library/Logs/later.dog Dev");
  assert.equal(logsDirFor(dev, { home: HOME, platform: "linux", userData: "/u/later.dog Dev" }), "/u/later.dog Dev/logs");
});

test("the two variants listen on disjoint ports, helpers and profile servers included", () => {
  const left = ownedPorts(release);
  const right = ownedPorts(dev);
  const shared = [...left].filter((port) => right.has(port));
  assert.deepEqual(shared, []);
  assert.ok(left.has(8799) && left.has(8800) && left.has(9010) && left.has(8798) && left.has(8811));
  assert.ok(left.has(8810) && right.has(8910) && right.has(8909));
  assert.ok(right.has(8999) && right.has(9000) && right.has(9110) && right.has(8998) && right.has(8911));
  for (const definition of [release, dev]) {
    assert.equal(new Set(definition.ports.server).size, definition.ports.server.length);
    assert.equal((definition.ports.profiles.last - definition.ports.profiles.first) % 2, 0);
  }
  assert.equal(serverPortRange(dev), "8999–28999");
});

test("Dev's deep links are not the release's, in either direction", () => {
  const releasePattern = deepLinkPattern(release, ["trial", "plan"]);
  const devPattern = deepLinkPattern(dev, ["trial", "plan"]);
  assert.equal(releasePattern.test("laterdog://trial"), true);
  assert.equal(releasePattern.test("laterdog-dev://trial"), false);
  assert.equal(devPattern.test("laterdog-dev://plan/x"), true);
  assert.equal(devPattern.test("laterdog://plan"), false);
  assert.equal(deepLink(dev, "organization"), "laterdog-dev://organization");
});

test("applying the variant environment moves only Dev's supervisor, and leaves the release's environment alone", () => {
  assert.deepEqual(applyVariantEnvironment(release, { KEEP: "1", LATERDOG_PORT: "1234" }), { KEEP: "1", LATERDOG_PORT: "1234" });
  assert.equal(APP_VARIANT_ENV in applyVariantEnvironment(release, { [APP_VARIANT_ENV]: "dev" }), false);
  assert.deepEqual(applyVariantEnvironment(dev, { KEEP: "1", LATERDOG_PORT: "9010" }), { KEEP: "1", LATERDOG_PORT: "9110", [APP_VARIANT_ENV]: "dev" });
});

test("every module that parses or registers a deep link follows the running variant", () => {
  const probe = `
    const cloud = await import("./electron/cloud-entry.mjs");
    const org = await import("./electron/organization-entry.mjs");
    const link = await import("./electron/package-link.mjs");
    const install = "https://github.com/acme/pack/blob/main/pack.json";
    console.log(JSON.stringify({
      cloud: cloud.CLOUD_DEEP_LINK,
      organization: org.ORGANIZATION_DEEP_LINK,
      ownInstall: link.packageUrlFromDeepLink("PREFIX://install?url=" + encodeURIComponent(install)),
    }));`;
  const run = (variantName, prefix) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", probe.replace("PREFIX", prefix)], {
    cwd: root, env: { ...process.env, LATERDOG_VARIANT: variantName }, encoding: "utf8",
  }).stdout);
  const install = "https://github.com/acme/pack/blob/main/pack.json";
  assert.deepEqual(run("release", "laterdog"), { cloud: "laterdog://cloud", organization: "laterdog://organization", ownInstall: install });
  assert.deepEqual(run("release", "laterdog-dev"), { cloud: "laterdog://cloud", organization: "laterdog://organization", ownInstall: null });
  assert.deepEqual(run("dev", "laterdog-dev"), { cloud: "laterdog-dev://cloud", organization: "laterdog-dev://organization", ownInstall: install });
  assert.deepEqual(run("dev", "laterdog"), { cloud: "laterdog-dev://cloud", organization: "laterdog-dev://organization", ownInstall: null });
});

test("dev scripts default to isolated data and ports, and refuse the live app", () => {
  const safe = scriptTarget({ argv: [], env: {}, home: HOME });
  assert.equal(safe.live, false);
  assert.equal(safe.home, "/Users/someone/.laterdog-dev-scripts");
  assert.equal(safe.serverPort, 9011);
  assert.equal(safe.supervisorPort, 9111);
  const inRelease = new Set([...release.ports.server, release.ports.supervisor]);
  assert.equal(inRelease.has(safe.serverPort) || inRelease.has(safe.supervisorPort), false);
  assert.match(scriptTarget({ argv: [], env: { LATERDOG_HOME: "/Users/someone/.laterdog" }, home: HOME }).refusal, /belongs to the released later\.dog app/);
  assert.match(scriptTarget({ argv: [], env: { LATERDOG_HOME: "/Users/someone/.laterdog/supervisor" }, home: HOME }).refusal, new RegExp(LIVE_DATA_FLAG));
  for (const port of ["8799", "18799", "28799"]) assert.match(scriptTarget({ argv: [], env: { LATERDOG_SERVER_PORT: port }, home: HOME }).refusal, /port/);
  assert.match(scriptTarget({ argv: [], env: { LATERDOG_PORT: "9010" }, home: HOME }).refusal, /port 9010/);
  assert.equal(scriptTarget({ argv: [], env: { LATERDOG_HOME: "/tmp/fixture", LATERDOG_SERVER_PORT: "40123" }, home: HOME }).home, "/tmp/fixture");
});

test("reaching live data takes the loudly named flag or its environment variable", () => {
  const viaFlag = scriptTarget({ argv: [LIVE_DATA_FLAG], env: {}, home: HOME });
  assert.equal(viaFlag.live, true);
  assert.equal(viaFlag.home, "/Users/someone/.laterdog");
  const viaEnvironment = scriptTarget({ argv: [], env: { [LIVE_DATA_ENV]: "1", LATERDOG_SERVER_PORT: "8799" }, home: HOME });
  assert.equal(viaEnvironment.live, true);
  assert.equal(viaEnvironment.serverPort, 8799);
  assert.equal(scriptTarget({ argv: [], env: { [LIVE_DATA_ENV]: "true" }, home: HOME }).live, false);
  assert.ok(LIVE_DATA_FLAG.length > 20 && /live/.test(LIVE_DATA_FLAG));
});

test("no electron module names the release's identity by hand any more", () => {
  const forbidden = [
    [/laterdog:\/\//, "a laterdog:// deep link"],
    [/(?<![0-9])(?:8|18|28)799(?![0-9])/, "a release server port"],
    [/(?<![0-9])(?:8|18|28)798(?![0-9])/, "a release relay port"],
    [/dog\.later\.app/, "the release app id"],
    [/setAsDefaultProtocolClient\(\s*["']/, "a literal protocol scheme"],
    [/app\.setName\(\s*["']/, "a literal app name"],
    [/["']\.laterdog["']/, "the release data folder name"],
    [/FIRST_PORT\s*=\s*\d/, "a literal profile port range"],
  ];
  const skip = new Set(["app-variant.cjs", "app-variant.mjs", "app-variant.d.mts", "save-file.mjs"]);
  const offenders = [];
  for (const name of readdirSync(directory)) {
    if (!/\.(?:mjs|cjs)$/.test(name) || /\.(?:node-test|test)\.mjs$/.test(name) || skip.has(name)) continue;
    const source = readFileSync(path.join(directory, name), "utf8");
    for (const [pattern, label] of forbidden) if (pattern.test(source)) offenders.push(`${name}: ${label}`);
  }
  assert.deepEqual(offenders, []);
});

test("the Dev build config and the release build config agree on everything but identity", async () => {
  const { parse } = await import("yaml");
  const base = parse(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
  const devConfig = parse(readFileSync(path.join(root, "electron-builder.dev.yml"), "utf8"));
  assert.equal(devConfig.extends, "./electron-builder.yml");
  assert.equal(devConfig.appId, "dog.later.app.dev");
  assert.equal(devConfig.productName, "later.dog Dev");
  assert.deepEqual(devConfig.protocols, [{ name: "later.dog Dev package install", schemes: ["laterdog-dev"] }]);
  assert.notEqual(devConfig.appId, base.appId);
  assert.equal(devConfig.mac.icon, "build/dev/icon.icns");
  assert.equal(devConfig.mac.extraResources, undefined, "Dev must not list extraResources: electron-builder would add them to the release's, not replace them");
  assert.ok(base.files.includes("!electron/resources/app-update.yml"));
  assert.equal(readFileSync(path.join(root, "electron/resources/app-update-dev.yml"), "utf8").trim(), `updaterCacheDirName: ${dev.updates.cacheDirName}`);
  assert.equal(readFileSync(path.join(root, "electron/resources/app-update.yml"), "utf8").trim(), `updaterCacheDirName: ${release.updates.cacheDirName}`);
  assert.equal(devConfig.dmg.title, "later.dog Dev");
});

test("Dev keeps its phone companion inside its own data folder", () => {
  assert.equal(companionDirFor(dev, { env: {}, home: HOME }), "/Users/someone/.laterdog-dev/companion");
  assert.equal(companionDirFor(dev, { env: { LATERDOG_HOME: "/Users/someone/.laterdog" }, home: HOME }), "/Users/someone/.laterdog-dev/companion");
  assert.equal(companionDirFor(dev, { env: { LATERDOG_HOME: "/tmp/fixture-home" }, home: HOME }), "/tmp/fixture-home/companion");
});

test("a symlink or a different spelling of the release folder is still the release folder", () => {
  const home = mkdtempSync(path.join(tmpdir(), "laterdog-variant-home-"));
  try {
    mkdirSync(path.join(home, ".laterdog"));
    symlinkSync(path.join(home, ".laterdog"), path.join(home, "shortcut"));
    const own = path.join(home, ".laterdog-dev");
    assert.equal(dataDirFor(dev, { env: { LATERDOG_HOME: path.join(home, "shortcut") }, home }), own);
    assert.equal(dataDirFor(dev, { env: { LATERDOG_HOME: path.join(home, "shortcut", "supervisor") }, home }), own);
    assert.equal(dataDirFor(dev, { env: { LATERDOG_HOME: path.join(home, ".LATERDOG") }, home }), process.platform === "linux" ? path.join(home, ".LATERDOG") : own);
    assert.equal(insidePath(path.join(home, ".laterdog"), path.join(home, ".LaterDog", "x"), { caseInsensitive: true }), true);
    if (process.platform === "linux") assert.equal(insidePath(path.join(home, ".laterdog"), path.join(home, ".LaterDog", "x"), { caseInsensitive: false }), false);
    assert.equal(insidePath(path.join(home, ".laterdog"), path.join(home, ".laterdog-dev"), { caseInsensitive: true }), false);
    assert.match(scriptTarget({ argv: [], env: { LATERDOG_HOME: path.join(home, "shortcut") }, home }).refusal, /belongs to the released later\.dog app/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the builder config for Dev still carries the release's scheme, which the after-pack step must remove", async () => {
  const requireFromBuilder = createRequire(createRequire(path.join(root, "package.json")).resolve("electron-builder/package.json"));
  const { getConfig } = requireFromBuilder("app-builder-lib/out/util/config/config.js");
  const merged = await getConfig(root, "electron-builder.dev.yml", null);
  const schemes = merged.protocols.flatMap((entry) => entry.schemes);
  assert.ok(schemes.includes("laterdog-dev"));
  assert.ok(schemes.includes("laterdog"), "electron-builder no longer concatenates protocols; the after-pack scheme step may be unnecessary");
  const { urlTypesWithOnlyScheme } = await import("../scripts/dev-update-config.mjs");
  const urlTypes = merged.protocols.map((entry) => ({ CFBundleURLName: entry.name, CFBundleURLSchemes: entry.schemes }));
  const kept = urlTypesWithOnlyScheme(urlTypes, dev.scheme);
  assert.deepEqual(kept.flatMap((entry) => entry.CFBundleURLSchemes), ["laterdog-dev"]);
  assert.equal(kept.length, 1);
  assert.deepEqual(urlTypesWithOnlyScheme(undefined, "laterdog-dev"), []);
});

test("the release builder config keeps the Dev-only files out of the release app", async () => {
  const { parse } = await import("yaml");
  const base = parse(readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
  assert.ok(base.files.includes("!electron/resources/app-update-dev.yml"));
  assert.equal(existsSync(path.join(root, "electron/resources/app-icon-dev.png")), false);
  const devConfig = parse(readFileSync(path.join(root, "electron-builder.dev.yml"), "utf8"));
  assert.deepEqual(devConfig.files, ["build/dev/icon.png"]);
  assert.equal(path.resolve(directory, dev.iconPath), path.join(root, "build/dev/icon.png"));
});
