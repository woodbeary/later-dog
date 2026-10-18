let localOrigin = null;

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

function isLocalSender(event) {
  return localOrigin !== null && senderOrigin(event) === localOrigin;
}

function localOnly(channel, handler) {
  return (event, ...args) => {
    if (!isLocalSender(event)) throw new Error(`${channel} is only available while using the local server`);
    return handler(event, ...args);
  };
}

function localOnlySync(channel, handler, denied = false) {
  return (event, ...args) => {
    if (!isLocalSender(event)) {
      event.returnValue = denied;
      return;
    }
    return handler(event, ...args);
  };
}

module.exports = {
  getLocalOrigin,
  isLocalSender,
  localOnly,
  localOnlySync,
  senderOrigin,
  setLocalOrigin,
};
