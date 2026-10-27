import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

const INHERITED_FROM_A_RUNNING_APP = [
  "CLAUDE_CONFIG_DIR",
  "LATERDOG_APP_VERSION",
  "LATERDOG_CREDENTIAL_STORE",
  "LATERDOG_CUA_SDK_LIBRARY",
  "LATERDOG_DESKTOP_PARENT",
  "LATERDOG_DESKTOP_PROFILE",
  "LATERDOG_HOOK_HELPER",
  "LATERDOG_HOOK_NODE",
  "LATERDOG_HOOK_TOKEN_FILE",
  "LATERDOG_HOOK_URL",
  "LATERDOG_RESOURCES_PATH",
  "LATERDOG_SERVER_PORT",
  "LATERDOG_STATIC_DIR",
  "LATERDOG_USER_DATA",
  "LATERDOG_WEBHOOK_PORT",
];

const home = mkdtempSync(join(tmpdir(), "laterdog-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.LATERDOG_HOME;
delete process.env.HERMES_HOME;
delete process.env.TZ;
for (const name of INHERITED_FROM_A_RUNNING_APP) delete process.env[name];
process.env.LATERDOG_COMPANION_DIR = join(home, ".laterdog-companion");
process.env.LATERDOG_TRIAL_API = "off";

Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
