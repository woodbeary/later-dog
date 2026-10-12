
const DESKTOP_VIEWER_PERMISSIONS = new Set([
  "keyboardLock",
  "pointerLock",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

function webOrigin(value) {
  if (Object.prototype.toString.call(value) !== "[object String]") return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin) {
  if (!DESKTOP_VIEWER_PERMISSIONS.has(permission)) return false;
  const requesting = webOrigin(requestingOrigin);
  return requesting !== null && requesting === webOrigin(viewerOrigin);
}
