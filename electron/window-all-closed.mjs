export function createAllWindowsClosedQuit({ app, platform = process.platform, allWindows }) {
  let startupSettled = false;
  const maybeQuit = () => {
    if (platform === "darwin" || !startupSettled) return;
    if (allWindows().length > 0) return;
    app.quit();
  };
  app.on("window-all-closed", maybeQuit);
  return {
    settleStartup: () => {
      startupSettled = true;
      maybeQuit();
    },
  };
}
