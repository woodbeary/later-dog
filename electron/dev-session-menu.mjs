export const RESTART_CODE = 75;
export const EARLIER_CODE = 76;
export const SWITCH_CODE = 77;

function workspaceItems(env, quitWith) {
  if (env.LATERDOG_DEV_WORKSPACE === "home") {
    return [
      { type: "separator" },
      { label: "Showing your later.dog Cloud chats", enabled: false },
      { label: "Switch to This Mac's Dev Dogs", click: () => quitWith(SWITCH_CODE) },
    ];
  }
  if (env.LATERDOG_DEV_HOME_AVAILABLE === "1") return [{ type: "separator" }, { label: "Switch to My later.dog Cloud", click: () => quitWith(SWITCH_CODE) }];
  return [];
}

export function devSessionItems(env, quitWith, appName) {
  if (env.LATERDOG_DEV_SESSION !== "1") return [];
  const earlier = env.LATERDOG_DEV_SESSION_VERSION?.trim();
  return [
    { type: "separator" },
    ...(earlier ? [{ label: `Running the code from ${earlier}`, enabled: false }] : []),
    { label: earlier ? "Back to the Latest Code" : `Restart ${appName}`, click: () => quitWith(RESTART_CODE) },
    { label: "Open an Earlier Version…", click: () => quitWith(EARLIER_CODE) },
    ...workspaceItems(env, quitWith),
  ];
}

export function quitWithCode(app, code) {
  app.once("will-quit", (event) => {
    event.preventDefault();
    app.exit(code);
  });
  app.quit();
}
