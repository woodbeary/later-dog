// The macOS privacy grants a bot on this Mac needs, read for the welcome
// tour's Permissions step, Settings → Computers → Permissions and the Bot's
// computer panel. Pure: the Electron surfaces (systemPreferences,
// desktopCapturer) are passed in, so every branch runs under node:test
// without a display or a TCC database.
//
// Three grants, one status each (granted | denied | notDetermined | unavailable):
//   microphone     getMediaAccessStatus("microphone"); askForMediaAccess shows
//                  the system prompt once, then System Settings is the way back.
//   accessibility  isTrustedAccessibilityClient(false). With `true` macOS shows
//                  its dialog and lists the app under Accessibility. There is
//                  no "not asked yet" here: AXIsProcessTrusted only answers
//                  yes or no, so an app never asked reads as denied.
//   screen         getMediaAccessStatus("screen"), which wraps
//                  CGPreflightScreenCaptureAccess. macOS 15+ caches that
//                  answer per process: a grant made in System Settings can
//                  read as denied until the app relaunches, and the checklist
//                  says so beside the row. The only prompt macOS offers is a
//                  real capture, so `request` takes one 1×1 thumbnail of this
//                  screen and discards it. A denial is never re-prompted.
// Anywhere but macOS every status is "unavailable": nothing to ask for.

export const DESKTOP_PERMISSIONS = Object.freeze(["microphone", "accessibility", "screen"]);

const UNAVAILABLE = Object.freeze({ microphone: "unavailable", accessibility: "unavailable", screen: "unavailable" });

/** Electron's TCC words → the checklist's four. */
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

/**
 * What macOS reports to this process right now.
 *
 * @param {{ platform: string, systemPreferences?: object }} host
 * @returns {{ microphone: string, accessibility: string, screen: string }}
 */
export function permissionChecklist({ platform, systemPreferences }) {
  if (platform !== "darwin") return { ...UNAVAILABLE };
  return {
    microphone: mediaStatus(systemPreferences, "microphone"),
    accessibility: accessibilityStatus(systemPreferences),
    screen: mediaStatus(systemPreferences, "screen"),
  };
}

/**
 * Show the real system prompt for one grant, then read everything again. A
 * grant macOS will not prompt for again (a denial) is simply read again; the
 * renderer offers System Settings for it.
 *
 * @param {unknown} permission One of DESKTOP_PERMISSIONS, as the renderer sent it
 * @param {{ platform: string, systemPreferences?: object, desktopCapturer?: object }} host
 */
export async function requestPermission(permission, host) {
  if (!DESKTOP_PERMISSIONS.includes(permission)) throw new Error("Unknown permission");
  if (host.platform !== "darwin") return { ...UNAVAILABLE };
  const { systemPreferences, desktopCapturer } = host;
  try {
    if (permission === "microphone") await systemPreferences.askForMediaAccess("microphone");
    else if (permission === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
    else await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  } catch {
    // The prompt could not be shown; the status below says where things stand.
  }
  return permissionChecklist(host);
}
