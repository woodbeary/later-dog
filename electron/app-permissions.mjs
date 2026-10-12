
const ALLOWED_APP_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

function webOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function appPermissionAllowed(permission, requestingUrlOrOrigin, rendererOrigin, details = {}) {
  const requesting = webOrigin(requestingUrlOrOrigin);
  const allowed = webOrigin(rendererOrigin);
  if (!requesting || !allowed || requesting !== allowed) return false;

  if (permission === "media") {
    if (details?.mediaType !== undefined && details.mediaType !== "audio") return false;
    if (details?.mediaTypes !== undefined) {
      return Array.isArray(details.mediaTypes) && details.mediaTypes.every((type) => type === "audio");
    }
    return details?.mediaType === "audio";
  }

  return ALLOWED_APP_PERMISSIONS.has(permission);
}

function cloudHomeMicrophoneAllowed(permission, requestingUrlOrOrigin, homeOrigin, details) {
  if (permission !== "media" || details?.isMainFrame !== true || details.mediaTypes?.length === 0) return false;
  return appPermissionAllowed("media", requestingUrlOrOrigin, homeOrigin, details);
}

export function remoteClipboardWriteAllowed(permission, requestingUrlOrOrigin, activeRemoteOrigin, details = {}) {
  if (permission !== "clipboard-sanitized-write") return false;
  if (details?.isMainFrame !== true) return false;
  const requesting = webOrigin(requestingUrlOrOrigin);
  const active = webOrigin(activeRemoteOrigin);
  return Boolean(requesting && active && requesting === active);
}

export function appPermissionHandlers({ rendererOrigin, mainContents, cloudHomeOrigin, cloudHomeRestoring = () => null, activeRemoteOrigin = () => null }) {
  const asksAsCloud = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() && cloudHomeMicrophoneAllowed(permission, requesting, requesting, details);
  const clipboardWrite = (contents, permission, requesting, details) =>
    Boolean(contents) && contents === mainContents() &&
    (remoteClipboardWriteAllowed(permission, requesting, activeRemoteOrigin(), details) ||
      remoteClipboardWriteAllowed(permission, requesting, cloudHomeOrigin(), details));
  const allowed = (contents, permission, requesting, details) =>
    appPermissionAllowed(permission, requesting, rendererOrigin(), details) ||
    (asksAsCloud(contents, permission, requesting, details) && cloudHomeMicrophoneAllowed(permission, requesting, cloudHomeOrigin(), details)) ||
    clipboardWrite(contents, permission, requesting, details);
  return {
    request: (contents, permission, callback, details) => {
      const requesting = details?.requestingUrl ?? contents?.getURL?.() ?? "";
      if (allowed(contents, permission, requesting, details)) return callback(true);
      const restoring = asksAsCloud(contents, permission, requesting, details) ? cloudHomeRestoring() : null;
      if (!restoring) return callback(false);
      void Promise.resolve(restoring).catch(() => {}).then(() => callback(allowed(contents, permission, requesting, details)));
    },
    check: (contents, permission, requestingOrigin, details) =>
      allowed(contents, permission, requestingOrigin || contents?.getURL?.() || "", details),
    pageMicrophone: (event) => {
      const contents = event?.sender;
      const frame = event?.senderFrame;
      const isMainFrame = Boolean(frame) && frame === contents?.mainFrame;
      return allowed(contents, "media", frame?.url ?? "", { isMainFrame, mediaTypes: ["audio"] }) ? "allowed" : "refused";
    },
  };
}

export function externalWebUrl(rawUrl) {
  if (typeof rawUrl !== "string") throw new Error("A web address is required");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only web links can be opened");
  if (url.username || url.password) throw new Error("Web links must not include user credentials");
  return url.toString();
}
