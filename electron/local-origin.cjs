let localOrigin = null;
let profileOrigin = () => null;

const PROFILE_CHANNELS = new Set([
  "approvals:set-trusted-mode",
  "clipboard:write-text",
  "credential:set",
  "credential:retry",
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
  "speech:audio",
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

function senderOrigin(event) {
  const frameUrl = event?.senderFrame?.url;
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
  return localOrigin !== null && senderOrigin(event) === localOrigin;
}

function localOnly(channel, handler) {
  return (event, ...args) => {
    if (!allowedSender(channel, event)) throw new Error(`${channel} is only available while using the local server`);
    return handler(event, ...args);
  };
}

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
