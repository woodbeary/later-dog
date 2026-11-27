export const STOP_CHILD_MS = 20_000;

export async function switchLauncher({ previous, start, save, carryOn = () => true, stopMs = STOP_CHILD_MS }) {
  const exited = new Promise((resolve) => previous.once("exit", resolve));
  if (previous.exitCode === null && previous.signalCode === null) previous.kill("SIGTERM");
  const late = setTimeout(() => { if (previous.exitCode === null) previous.kill("SIGKILL"); }, stopMs);
  await exited;
  clearTimeout(late);
  if (!carryOn()) return false;
  start();
  void save();
  return true;
}
