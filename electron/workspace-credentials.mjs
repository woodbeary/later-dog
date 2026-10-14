export const WORKSPACE_CREDENTIALS = [
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "LATERDOG_TTS_KEY" },
  { section: "tts", field: "fishKey", name: "fishAudioKey", env: "LATERDOG_FISH_AUDIO_API_KEY" },
  { section: "decider", field: "key", name: "jevApiKey", env: "LATERDOG_JEV_API_KEY" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "LATERDOG_OPENAI_IMAGE_KEY" },
  { section: "imageGen", field: "customApiKey", name: "customImageApiKey", env: "LATERDOG_CUSTOM_IMAGE_KEY" },
  { section: "typing", field: "token", name: "cloudflareAiToken", env: "LATERDOG_CLOUDFLARE_AI_TOKEN" },
  { section: "live", field: "key", name: "openaiLiveKey", env: "LATERDOG_OPENAI_LIVE_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
];

export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  return env;
}
