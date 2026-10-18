export function speechSender(channel, handler, { isLocal, isCloudPage }) {
  return (event, ...args) => {
    if (!isLocal(event) && !isCloudPage(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(event, ...args);
  };
}

const watchedPages = new WeakSet();

export function stopSpeechWhenPageLeaves(contents, stop) {
  if (!contents || watchedPages.has(contents)) return;
  watchedPages.add(contents);
  contents.on("did-start-navigation", (details, _url, isInPlace, isMainFrame) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame;
    const sameDocument = details?.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) void stop();
  });
}
