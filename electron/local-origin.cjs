// Which page is asking. The main window shows either the local server's UI or
// a paired remote server's UI; anything that touches THIS computer (screen,
// files, logins, helpers, updater, local control) answers only the former.
// main.mjs sets the local origin once it knows the port; every IPC module
// wraps its handlers with localOnly(). Pure, so it is unit-tested.
let localOrigin = null;
let profileOrigin = () => null;

const PROFILE_CHANNELS = new Set([
  "approvals:set-trusted-mode",
  "clipboard:write-text",
  "credential:set",
  "desktop:export-diagnostics",
  "desktop:open-external",
  "desktop:pick-folder",
  "desktop:relaunch",
  "desktop:reveal-file",
  "desktop:save-file",
  "dialog:confirm",
  "engine:open-terminal",
  "perm:checklist",
  "perm:open-settings",
  "perm:request",
  "perm:request-mic",
  "release-check:set",
  "screen:frame",
  "screen:preview-intent",
  "speech:finish",
  "speech:start",
  "speech:stop",
]);

function setLocalOrigin(origin) {
  localOrigin = typeof origin === "string" && origin ? origin : null;
}

function getLocalOrigin() {
  return localOrigin;
}

/** The origin of the frame that sent an IPC message, or null when unknown. */
function senderOrigin(event) {
  const frameUrl = event?.senderFrame?.url;
  // Electron can briefly report an empty URL for the main frame while the
  // local renderer is committing a navigation (including after restoring a
  // company workspace). Fall back to WebContents only for that exact main
  // frame. A child frame with an empty URL still fails closed: it must never
  // inherit the trusted origin of its parent page.
  const emptyKnownChild =
    event?.senderFrame &&
    event?.sender?.mainFrame &&
    event.senderFrame !== event.sender.mainFrame;
  const url = frameUrl || (!emptyKnownChild && typeof event?.sender?.getURL === "function" ? event.sender.getURL() : "");
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function setProfileOrigin(resolve) {
  profileOrigin = typeof resolve === "function" ? resolve : () => null;
}

function isProfileSender(event) {
  let origin = null;
  try {
    origin = profileOrigin();
  } catch {
    origin = null;
  }
  return typeof origin === "string" && origin !== "" && senderOrigin(event) === origin;
}

function allowedSender(channel, event) {
  return isLocalSender(event) || (PROFILE_CHANNELS.has(channel) && isProfileSender(event));
}

function isLocalSender(event) {
  // Until the local origin is known nothing is local: fail closed.
  return localOrigin !== null && senderOrigin(event) === localOrigin;
}

/** Wrap an ipcMain.handle handler so a page that is not the local server's
 * UI gets a clear error instead of an answer. */
function localOnly(channel, handler) {
  return (event, ...args) => {
    if (!allowedSender(channel, event)) throw new Error(`${channel} is only available while using the local server`);
    return handler(event, ...args);
  };
}

/** Same for ipcMain.on / sendSync: answer `denied` and stop. */
function localOnlySync(channel, handler, denied = false) {
  return (event, ...args) => {
    if (!allowedSender(channel, event)) {
      event.returnValue = denied;
      return;
    }
    return handler(event, ...args);
  };
}

module.exports = {
  PROFILE_CHANNELS,
  getLocalOrigin,
  isLocalSender,
  isProfileSender,
  localOnly,
  localOnlySync,
  senderOrigin,
  setLocalOrigin,
  setProfileOrigin,
};
