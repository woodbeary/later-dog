
const RENAME_ASSIGNMENT =
  /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;

const IN_PLACE_ASSIGNMENT = "destination = appImageFile;";

const UNLINK_BEFORE_INSTALL = /^\s*\(0, fs_1\.unlinkSync\)\(appImageFile\);\n/m;

const MOVE_INTO_PLACE =
  /\(0, child_process_1\.execFileSync\)\("mv", \["-f", installerPath, destination\]\);/;

const ATOMIC_MOVE = [
  'const stagedDestination = `${destination}.new`;',
  '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination]);',
  "(0, fs_1.renameSync)(stagedDestination, destination);",
].join("\n        ");

const IMMEDIATE_RELAUNCH = /this\.spawnLog\(destination, \[\], env\);/g;
const QUEUED_RELAUNCH = [
  'const previousSilentInstall = process.env.APPIMAGE_SILENT_INSTALL;',
  'try {',
  '  process.env.APPIMAGE_SILENT_INSTALL = env.APPIMAGE_SILENT_INSTALL;',
  '  if (require("electron").app.relaunch({ execPath: destination, args: [] }) === false) {',
  '    throw new Error("Could not schedule the updated AppImage to restart");',
  '  }',
  '} finally {',
  '  if (previousSilentInstall === undefined) delete process.env.APPIMAGE_SILENT_INSTALL;',
  '  else process.env.APPIMAGE_SILENT_INSTALL = previousSilentInstall;',
  '}',
].join("\n          ");

const REPLACEMENTS = [
  ["rename branch", RENAME_ASSIGNMENT, IN_PLACE_ASSIGNMENT],
  ["unlink before install", UNLINK_BEFORE_INSTALL, ""],
  ["move into place", MOVE_INTO_PLACE, ATOMIC_MOVE],
  ["immediate relaunch", IMMEDIATE_RELAUNCH, QUEUED_RELAUNCH],
];

export function patchAppImageUpdater(source) {
  let patched = source;
  for (const [label, pattern, replacement] of REPLACEMENTS) {
    const found = patched.match(pattern);
    const count = found ? (pattern.global ? found.length : 1) : 0;
    if (count !== 1) {
      throw new Error(
        `Expected exactly 1 AppImage "${label}" site to patch, found ${count}. ` +
          "electron-updater's AppImageUpdater.doInstall changed shape — re-read it and update " +
          "scripts/patch-appimage-updater.mjs before releasing.",
      );
    }
    patched = patched.replace(pattern, replacement);
  }
  return patched;
}
