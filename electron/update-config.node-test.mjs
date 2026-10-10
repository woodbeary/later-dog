import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every mac build ships the app-update.yml the updater reads before it downloads", async (t) => {
  const builder = parse(readFileSync(join(root, "electron-builder.yml"), "utf8"));
  const shipped = builder.mac.extraResources.find((resource) => resource.to === "app-update.yml");
  assert.ok(shipped, "electron-builder.yml ships no app-update.yml in the mac app");
  assert.ok(builder.files.includes(`!${shipped.from}`), "app-update.yml belongs in Resources, not in app.asar");

  const load = Module._load;
  Module._load = (request, ...rest) => (request === "electron" ? { app: {}, autoUpdater: new EventEmitter() } : load(request, ...rest));
  t.after(() => {
    Module._load = load;
  });
  const { AppUpdater } = createRequire(import.meta.url)("./vendor/electron-updater.cjs");

  const errors = [];
  const updater = {
    _appUpdateConfigPath: join(root, shipped.from),
    _logger: { error: (message) => errors.push(message), info() {}, warn() {} },
    app: { baseCachePath: tmpdir(), name: "later.dog" },
    downloadedUpdateHelper: null,
  };
  updater.configOnDisk = { value: AppUpdater.prototype.loadUpdateConfig.call(updater) };
  const helper = await AppUpdater.prototype.getOrCreateDownloadHelper.call(updater);
  assert.deepEqual(errors, []);
  assert.equal(helper.cacheDir, join(tmpdir(), "laterdog-updater"));
});
