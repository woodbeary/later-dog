const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VARIANT_ENV = "LATERDOG_VARIANT";
const VARIANT_FIELD = "laterdogVariant";
const APP_VARIANT_ENV = "LATERDOG_APP_VARIANT";
const RELEASE = "release";
const DEV = "dev";
const VARIANT_IDS = Object.freeze([RELEASE, DEV]);

const DEFINITIONS = Object.freeze({
  [RELEASE]: Object.freeze({
    id: RELEASE,
    productName: "later.dog",
    appId: "dog.later.app",
    scheme: "laterdog",
    dataDirName: ".laterdog",
    userDataDirName: "later.dog",
    logsDirName: null,
    desktopEntry: "dog.later.app.desktop",
    cuaHostBundleId: "dog.later.app",
    tempPrefix: "laterdog",
    iconPath: "resources/app-icon.png",
    ports: Object.freeze({
      companion: 8810,
      companionControl: 8811,
      server: Object.freeze([8799, 18799, 28799]),
      webhookOffset: 1,
      companionRelay: Object.freeze([8798, 18798, 28798]),
      supervisor: 9010,
      profiles: Object.freeze({ first: 8811, last: 8899 }),
    }),
    updates: Object.freeze({ channel: null, feedFile: "latest-mac.yml", cacheDirName: "laterdog-updater", releaseCheck: true }),
  }),
  [DEV]: Object.freeze({
    id: DEV,
    productName: "later.dog Dev",
    appId: "dog.later.app.dev",
    scheme: "laterdog-dev",
    dataDirName: ".laterdog-dev",
    userDataDirName: "later.dog Dev",
    logsDirName: "later.dog Dev",
    desktopEntry: "dog.later.app.dev.desktop",
    cuaHostBundleId: "dog.later.app.dev",
    tempPrefix: "laterdog-dev",
    iconPath: "../build/dev/icon.png",
    ports: Object.freeze({
      companion: 8910,
      companionControl: 8909,
      server: Object.freeze([8999, 18999, 28999]),
      webhookOffset: 1,
      companionRelay: Object.freeze([8998, 18998, 28998]),
      supervisor: 9110,
      profiles: Object.freeze({ first: 8911, last: 8995 }),
    }),
    updates: Object.freeze({ channel: "dev", feedFile: "dev-mac.yml", cacheDirName: "laterdog-dev-updater", releaseCheck: false }),
  }),
});

const SCRIPT_DEFAULTS = Object.freeze({
  dataDirName: ".laterdog-dev-scripts",
  serverPort: 9011,
  uiPort: 5299,
  supervisorPort: 9111,
});

const LIVE_DATA_FLAG = "--use-my-live-dogs-and-real-data";
const LIVE_DATA_ENV = "LATERDOG_USE_MY_LIVE_DOGS";

function describeVariant(id) {
  const definition = DEFINITIONS[id];
  if (!definition) throw new Error(`Unknown later.dog variant "${id}". Use ${VARIANT_IDS.join(" or ")}.`);
  return definition;
}

function clean(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bundleIsDev(execPath) {
  const text = String(execPath ?? "");
  return /later\.dog Dev\.app(?:[\\/]|$)/.test(text) || /^later\.dog Dev(?:\.exe)?$/.test(path.basename(text)) || path.basename(text) === "laterdog-dev";
}

function readBundleIdentifier(execPath, readFile = fs.readFileSync) {
  const text = String(execPath ?? "");
  const at = text.indexOf(".app/Contents/MacOS/");
  if (at === -1) return null;
  try {
    const plist = String(readFile(path.join(text.slice(0, at + 4), "Contents", "Info.plist"), "utf8"));
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readBakedVariant(packageJson) {
  const baked = clean(packageJson?.[VARIANT_FIELD]);
  return VARIANT_IDS.includes(baked) ? baked : null;
}

function readPackageJson(directory = __dirname) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, "..", "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolveVariantId({
  env = process.env,
  packageJson = readPackageJson(),
  execPath = process.execPath,
  electronVersion = process.versions.electron,
  defaultApp = process.defaultApp === true,
  bundleIdentifier = () => readBundleIdentifier(execPath),
} = {}) {
  const packagedApp = Boolean(electronVersion) && !defaultApp;
  if (packagedApp) {
    return readBakedVariant(packageJson) === DEV || bundleIsDev(execPath) || bundleIdentifier() === DEFINITIONS[DEV].appId ? DEV : RELEASE;
  }
  const requested = clean(env[VARIANT_ENV]);
  if (requested && !VARIANT_IDS.includes(requested)) {
    throw new Error(`${VARIANT_ENV}=${env[VARIANT_ENV]} is not a later.dog variant. Use ${VARIANT_IDS.join(" or ")}.`);
  }
  if (requested) return requested;
  return electronVersion ? DEV : RELEASE;
}

function resolveVariant(input) {
  return describeVariant(resolveVariantId(input));
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function canonicalPath(target) {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
  }
}

function insidePath(parent, child, { caseInsensitive = process.platform !== "linux" } = {}) {
  const fold = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const relative = path.relative(fold(canonicalPath(parent)), fold(canonicalPath(child)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function releaseDataDir(home = os.homedir()) {
  return path.join(home, DEFINITIONS[RELEASE].dataDirName);
}

function dataDirFor(definition, { env = process.env, home = os.homedir() } = {}) {
  const own = path.join(home, definition.dataDirName);
  const configured = typeof env.LATERDOG_HOME === "string" && env.LATERDOG_HOME.trim() ? env.LATERDOG_HOME : "";
  if (!configured) return own;
  if (definition.id === RELEASE) return configured;
  const releaseDir = releaseDataDir(home);
  const releaseSiblings = [releaseDir, `${releaseDir}-profiles`, path.join(home, ".laterdog-v0")];
  return releaseSiblings.some((live) => insidePath(live, configured)) ? own : configured;
}

function profilesDataDirFor(definition, options) {
  return `${dataDirFor(definition, options)}-profiles`;
}

function userDataDirFor(definition, appData) {
  return path.join(appData, definition.userDataDirName);
}

function logsDirFor(definition, { home = os.homedir(), platform = process.platform, userData } = {}) {
  if (!definition.logsDirName) return null;
  if (platform === "darwin") return path.join(home, "Library", "Logs", definition.logsDirName);
  return userData ? path.join(userData, "logs") : null;
}

function deepLink(definition, host) {
  return `${definition.scheme}://${host}`;
}

function deepLinkPattern(definition, hosts) {
  return new RegExp(`^${definition.scheme}:\\/\\/(?:${hosts.join("|")})(?:[/?#]|$)`, "i");
}

function safeStorageService(definition) {
  return `${definition.productName} Safe Storage`;
}

function tempName(definition, name) {
  return `${definition.tempPrefix}-${name}`;
}

function serverPortRange(definition) {
  const ports = definition.ports.server;
  return `${ports[0]}–${ports[ports.length - 1]}`;
}

function webhookPortFor(definition, serverPort) {
  return serverPort + definition.ports.webhookOffset;
}

function ownedPorts(definition) {
  const { server, companionRelay, supervisor, profiles, webhookOffset, companion, companionControl } = definition.ports;
  const owned = new Set([supervisor, companion, companionControl]);
  for (const port of [...server, ...companionRelay]) {
    owned.add(port);
    if (server.includes(port)) owned.add(port + webhookOffset);
  }
  for (let port = profiles.first; port <= profiles.last; port += 2) {
    owned.add(port);
    owned.add(port + webhookOffset);
  }
  return owned;
}

function applyVariantEnvironment(definition, env = process.env) {
  if (definition.id === RELEASE) {
    delete env[APP_VARIANT_ENV];
    return env;
  }
  env.LATERDOG_PORT = String(definition.ports.supervisor);
  env[APP_VARIANT_ENV] = definition.id;
  return env;
}

function companionDirFor(definition, options) {
  return definition.id === RELEASE ? null : path.join(dataDirFor(definition, options), "companion");
}

function liveDataRequested({ argv = process.argv, env = process.env } = {}) {
  return argv.includes(LIVE_DATA_FLAG) || env[LIVE_DATA_ENV] === "1";
}

function scriptTarget({ argv = process.argv, env = process.env, home = os.homedir() } = {}) {
  const live = liveDataRequested({ argv, env });
  const release = DEFINITIONS[RELEASE];
  const requestedHome = typeof env.LATERDOG_HOME === "string" && env.LATERDOG_HOME.trim() ? env.LATERDOG_HOME : "";
  const requestedPort = Number(env.LATERDOG_SERVER_PORT) || null;
  const requestedSupervisor = Number(env.LATERDOG_PORT) || null;
  const livePorts = new Set([...release.ports.server, release.ports.supervisor]);
  const touchesLiveData = requestedHome && [releaseDataDir(home), `${releaseDataDir(home)}-profiles`, path.join(home, ".laterdog-v0")].some((dir) => insidePath(dir, requestedHome));
  const touchesLivePorts = [requestedPort, requestedSupervisor].some((port) => port && livePorts.has(port));
  if (live) {
    return {
      live: true,
      home: requestedHome || releaseDataDir(home),
      serverPort: requestedPort ?? undefined,
      supervisorPort: requestedSupervisor ?? undefined,
      uiPort: Number(env.LATERDOG_UI_PORT) || undefined,
    };
  }
  if (touchesLiveData || touchesLivePorts) {
    const what = touchesLiveData ? `the data folder ${requestedHome}` : `port ${touchesLivePorts && [requestedPort, requestedSupervisor].find((port) => port && livePorts.has(port))}`;
    return {
      refusal: `Refusing to use ${what}: that belongs to the released later.dog app. Dev scripts use ${path.join(home, SCRIPT_DEFAULTS.dataDirName)} and port ${SCRIPT_DEFAULTS.serverPort} by default. To really use your live dogs and data, add ${LIVE_DATA_FLAG} (or set ${LIVE_DATA_ENV}=1).`,
    };
  }
  return {
    live: false,
    home: requestedHome || path.join(home, SCRIPT_DEFAULTS.dataDirName),
    serverPort: requestedPort ?? SCRIPT_DEFAULTS.serverPort,
    supervisorPort: requestedSupervisor ?? SCRIPT_DEFAULTS.supervisorPort,
    uiPort: Number(env.LATERDOG_UI_PORT) || SCRIPT_DEFAULTS.uiPort,
  };
}

module.exports = {
  APP_VARIANT_ENV,
  companionDirFor,
  insidePath,
  readBundleIdentifier,
  applyVariantEnvironment,
  DEV,
  LIVE_DATA_ENV,
  LIVE_DATA_FLAG,
  RELEASE,
  SCRIPT_DEFAULTS,
  VARIANT_ENV,
  VARIANT_FIELD,
  VARIANT_IDS,
  bundleIsDev,
  dataDirFor,
  deepLink,
  deepLinkPattern,
  describeVariant,
  liveDataRequested,
  logsDirFor,
  ownedPorts,
  profilesDataDirFor,
  readPackageJson,
  releaseDataDir,
  resolveVariant,
  resolveVariantId,
  safeStorageService,
  samePath,
  scriptTarget,
  serverPortRange,
  tempName,
  userDataDirFor,
  webhookPortFor,
};
