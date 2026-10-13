import fs from "node:fs";
import path from "node:path";

export function bundlePathOf(execPath) {
  const at = String(execPath ?? "").indexOf(".app/Contents/MacOS/");
  return at === -1 ? null : execPath.slice(0, at + 4);
}

function writableDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function runningFromDownload({ app, platform = process.platform, execPath = process.execPath, writable = writableDirectory }) {
  if (platform !== "darwin" || !app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return false;
  const bundle = bundlePathOf(execPath);
  if (!bundle) return false;
  return bundle.includes("/AppTranslocation/") || !writable(path.dirname(bundle));
}

export async function offerMoveToApplications({ app, dialog, log, platform, execPath, writable }) {
  if (!runningFromDownload({ app, platform, execPath, writable })) return false;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Move later.dog to Applications?",
    detail: "It's running from the download right now. In Applications it stays put and keeps itself up to date.",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    log?.("left later.dog running outside Applications");
    return false;
  }
  try {
    const moved = app.moveToApplicationsFolder();
    log?.(moved ? "moved later.dog to Applications; relaunching from there" : "the move to Applications was cancelled");
    return moved;
  } catch (error) {
    log?.(`moving later.dog to Applications failed: ${error?.message ?? error}`);
    await dialog.showMessageBox({
      type: "warning",
      message: "later.dog couldn't move itself",
      detail: "Drag later.dog into Applications in Finder, then open it from there.",
      buttons: ["OK"],
    });
    return false;
  }
}
