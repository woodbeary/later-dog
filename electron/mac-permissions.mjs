
export const DESKTOP_PERMISSIONS = Object.freeze(["microphone", "accessibility", "screen"]);

const UNAVAILABLE = Object.freeze({ microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" });

export function permissionStatus(raw) {
  switch (raw) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
      return "notDetermined";
    default:
      return "unavailable";
  }
}

function mediaStatus(systemPreferences, mediaType) {
  try {
    return permissionStatus(systemPreferences?.getMediaAccessStatus?.(mediaType));
  } catch {
    return "unavailable";
  }
}

function accessibilityStatus(systemPreferences) {
  try {
    if (typeof systemPreferences?.isTrustedAccessibilityClient !== "function") return "unavailable";
    return systemPreferences.isTrustedAccessibilityClient(false) === true ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

export function permissionChecklist({ platform, systemPreferences }) {
  if (platform !== "darwin") return { ...UNAVAILABLE };
  return {
    microphone: mediaStatus(systemPreferences, "microphone"),
    accessibility: accessibilityStatus(systemPreferences),
    screen: mediaStatus(systemPreferences, "screen"),
  };
}

export async function requestPermission(permission, host) {
  if (!DESKTOP_PERMISSIONS.includes(permission)) throw new Error("Unknown permission");
  if (host.platform !== "darwin") return { ...UNAVAILABLE };
  const { systemPreferences, desktopCapturer } = host;
  try {
    if (permission === "microphone") await systemPreferences.askForMediaAccess("microphone");
    else if (permission === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    else await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  } catch {}
  return permissionChecklist(host);
}
