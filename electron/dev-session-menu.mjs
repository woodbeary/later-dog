export const RESTART_CODE = 75;
export const EARLIER_CODE = 76;

export function devSessionItems(env, quitWith, appName) {
  if (env.LATERDOG_DEV_SESSION !== "1") return [];
  const earlier = env.LATERDOG_DEV_SESSION_VERSION?.trim();
  return [
    { type: "separator" },
    ...(earlier ? [{ label: `Running the code from ${earlier}`, enabled: false }] : []),
    { label: earlier ? "Back to the Latest Code" : `Restart ${appName}`, click: () => quitWith(RESTART_CODE) },
    { label: "Open an Earlier Version…", click: () => quitWith(EARLIER_CODE) },
  ];
}

export function quitWithCode(app, code) {
  app.once("will-quit", (event) => {
    event.preventDefault();
    app.exit(code);
  });
  app.quit();
}
