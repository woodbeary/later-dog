import { cursorSignInPrompt } from "../../shared/device-sign-in.ts";
import type { DeviceSignIn, DeviceSignInState } from "../drivers/device-auth.ts";

const NOT_SIGNED_IN = /not (?:logged|signed) in|not authenticated|unauthenticated|logged out/i;
const SIGNED_IN = /logged in|signed in|authenticated/i;
const API_KEY = /api[ _-]?key/i;

export function readCursorStatus(code: number | null, output: string): DeviceSignInState {
  if (NOT_SIGNED_IN.test(output)) return "signed-out";
  if (code !== 0) return "unknown";
  if (SIGNED_IN.test(output)) return API_KEY.test(output) ? "other" : "signed-in";
  return "unknown";
}

function cursorLoginFailure(output: string): string {
  if (/(unknown|unrecognized|unexpected) (command|argument|option)/i.test(output)) {
    return "This server's Cursor CLI is too old to sign in from here. Update Cursor on the server, then try again.";
  }
  if (/expired|timed? ?out/i.test(output)) return "The Cursor sign-in link expired. Start sign-in again for a new link.";
  if (/denied|rejected|cancel/i.test(output)) return "Cursor sign-in was declined in the browser. Start sign-in again to try once more.";
  return "Cursor sign-in did not finish. Check the server's connection, then try again.";
}

export const CURSOR_DEVICE_SIGN_IN: DeviceSignIn = {
  prompt: cursorSignInPrompt,
  product: "Cursor",
  account: "Cursor",
  homeEnv: "CURSOR_CONFIG_DIR",
  homeDir: ".cursor",
  loginArgs: ["login"],
  loginEnv: { NO_OPEN_BROWSER: "1" },
  install: "Install it with Cursor's installer (https://cursor.com/install), then try again.",
  failure: cursorLoginFailure,
  status: { args: ["status"], read: readCursorStatus },
  logoutArgs: ["logout"],
};
