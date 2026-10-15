import { resolve } from "node:path";
import variantModule from "./app-variant.cjs";

export const {
  APP_VARIANT_ENV,
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
} = variantModule;

export function desktopUserDataDirFor(definition, appData, { packaged = true, env = process.env, argv = process.argv, home } = {}) {
  const fallback = userDataDirFor(definition, appData);
  if (packaged || definition.id !== DEV) return fallback;
  if (liveDataRequested({ argv, env })) throw new Error("The source Dev desktop cannot use live data.");
  if (typeof env.LATERDOG_HOME !== "string" || !env.LATERDOG_HOME.trim()) return fallback;
  const target = scriptTarget({ argv, env, home });
  if (target.refusal) throw new Error(target.refusal);
  const desktop = resolve(target.home, "desktop");
  if (!insidePath(target.home, desktop) || insidePath(desktop, target.home)) throw new Error("The source Dev desktop profile must stay inside its isolated workspace.");
  for (const protectedVariant of [describeVariant(RELEASE), definition]) {
    const protectedProfile = userDataDirFor(protectedVariant, appData);
    if (insidePath(protectedProfile, desktop) || insidePath(desktop, protectedProfile)) throw new Error("The source Dev desktop cannot share an installed app's profile.");
  }
  return desktop;
}

export const variant = resolveVariant();
