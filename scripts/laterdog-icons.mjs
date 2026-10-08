// Renders later.dog's mark into every raster the app ships: the macOS .icns, the Windows .ico,
// the Linux/Dock PNG and the Electron tray/splash image. `public/app-icon.svg` (inset, for the
// OS) and `public/laterdog.svg` (full-bleed, for the favicon and in-app logo) are the sources;
// nothing here is drawn by hand. Run with `pnpm laterdog:icons`.
import { app, BrowserWindow } from "electron";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const profile = resolve(".laterdog-scratch/icons-profile");
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setName("later.dog Icons");
app.setPath("userData", profile);

/** A Windows icon container holding PNG-compressed entries (supported since Vista); 256 is written as 0 per the format. */
function ico(entries) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length); let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at); directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); directory.writeUInt8(0, at + 3); directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8); directory.writeUInt32LE(offset, at + 12); offset += png.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

async function render(svg) {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", '<svg width="1024" height="1024" ')}</body></html>`)}`);
  const image = await window.webContents.capturePage();
  window.destroy();
  return image;
}

async function renderIcons() {
  const mark = readFileSync(resolve("public/app-icon.svg"), "utf8");
  const logo = readFileSync(resolve("public/laterdog.svg"), "utf8");
  const image = await render(mark);
  const dir = resolve(".laterdog-scratch/laterdog.iconset"); mkdirSync(dir, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(dir, `icon_${size}x${size}.png`), image.resize({ width: size, height: size }).toPNG());
    writeFileSync(join(dir, `icon_${size}x${size}@2x.png`), image.resize({ width: size * 2, height: size * 2 }).toPNG());
  }
  writeFileSync(resolve("build/icon.png"), image.toPNG());
  writeFileSync(resolve("build/icon.svg"), logo);
  // Dock, window, splash screen and tray all read this one PNG (electron/main.mjs APP_ICON).
  writeFileSync(resolve("electron/resources/app-icon.png"), image.toPNG());
  writeFileSync(resolve("build/icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: image.resize({ width: size, height: size }).toPNG() }))));
  if (process.platform === "darwin") execFileSync("iconutil", ["-c", "icns", dir, "-o", resolve("build/icon.icns")]);
  app.quit();
}
app.whenReady().then(renderIcons).catch((error) => { console.error(error.message); app.exit(1); });
