export function appVariantSuffix(env: NodeJS.ProcessEnv = process.env): "" | "-dev" {
  return env.LATERDOG_APP_VARIANT === "dev" ? "-dev" : "";
}

export function sharedVmViewerPort(env: NodeJS.ProcessEnv = process.env): number {
  return appVariantSuffix(env) === "-dev" ? 6180 : 6080;
}
