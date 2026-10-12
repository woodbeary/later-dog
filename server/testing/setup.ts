import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "laterdog-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.LATERDOG_HOME;
delete process.env.HERMES_HOME;
process.env.LATERDOG_COMPANION_DIR = join(home, ".laterdog-companion");
process.env.LATERDOG_TRIAL_API = "off";

Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
