#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const home = process.env.HOME;
if (process.env.LATERDOG_DEVICE_AUTH_FIXTURE !== "1" || !home || !isAbsolute(home)) {
  process.stderr.write("This fake CLI requires LATERDOG_DEVICE_AUTH_FIXTURE=1 and an isolated HOME.\n");
  process.exit(2);
}
const folder = join(home, ".config", "cursor");
const stored = join(folder, "auth.json");
const mode = process.env.FAKE_CURSOR_MODE || "success";
const args = process.argv.slice(2);
appendFileSync(join(home, "fake-cursor-calls.jsonl"), `${JSON.stringify({ args, noOpenBrowser: process.env.NO_OPEN_BROWSER ?? null })}\n`);

const signIn = () => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(stored, "{\"fixture\":\"offline, not a credential\"}\n", { mode: 0o600 });
  process.stdout.write("\nLogin successful!\n");
  process.exit(0);
};

const command = args.join(" ");
if (command === "--version") {
  process.stdout.write("2026.10.16-e3cb207\n");
} else if (command === "status") {
  if (mode === "status-broken") {
    process.stderr.write("Something went wrong secret-token\n");
    process.exit(3);
  }
  if (existsSync(stored)) process.stdout.write("\n ✓ Logged in as fixture@example.test\n\n");
  else {
    process.stdout.write("\n Not logged in\n\n");
    process.exitCode = 1;
  }
} else if (command === "models") {
  process.stdout.write("Available models\n\nauto - Auto (current)\ncomposer-2.5 - Composer 2.5\n");
} else if (command === "logout") {
  if (mode !== "logout-lies") rmSync(stored, { force: true });
  process.stdout.write("Logged out successfully\n");
} else if (command === "login") {
  writeFileSync(join(home, "fake-cursor-login.pid"), String(process.pid));
  if (process.env.NO_OPEN_BROWSER !== "1") {
    process.stderr.write("Opening the browser on the server.\n");
    setInterval(() => {}, 1000);
  } else {
    const page = mode === "evil"
      ? "https://cursor.com.evil.test/loginDeepControl?challenge=fixture"
      : "https://cursor.com/loginDeepControl?challenge=fixture-challenge&uuid=fixture-uuid&mode=login";
    process.stdout.write("Starting login process...\n\n");
    process.stdout.write(`Open the following URL to log in:\n\u001b[1m${page}\u001b[0m\n\nWaiting for browser authentication...\n`);
    const later = (then: () => void) => setTimeout(then, 80);
    if (mode === "success" || mode === "logout-lies") later(signIn);
    else if (mode === "approve") setInterval(() => { if (existsSync(join(home, ".laterdog-fake-cursor-approved"))) signIn(); }, 100);
    else if (mode === "denied") later(() => { process.stderr.write("Login was cancelled in the browser. secret-token\n"); process.exit(1); });
    else setInterval(() => {}, 1000);
  }
} else {
  process.stderr.write("Unsupported offline fixture command.\n");
  process.exitCode = 2;
}
