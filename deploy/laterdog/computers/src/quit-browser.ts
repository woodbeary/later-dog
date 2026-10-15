export const QUIT_BROWSER_WAIT_MS = 8_000;

export const QUIT_BROWSER_SCRIPT = [
  `pids=$(pgrep -u "$(id -u)" -x chromium) || exit 0`,
  `kill -TERM $pids 2>/dev/null`,
  `for _ in $(seq 1 60); do pgrep -u "$(id -u)" -x chromium >/dev/null || exit 0; sleep 0.1; done`,
  `exit 1`,
].join("\n");
