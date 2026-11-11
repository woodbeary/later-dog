import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { app, BrowserWindow } from "electron";

const [url, probePath] = process.argv.slice(-2);
const probe = `window.__report = (line) => console.log("SHELL " + line);\n${readFileSync(probePath, "utf8")}`;

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1440, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (details, _level, text) => {
    const message = typeof text === "string" ? text : details.message;
    if (typeof message === "string" && message.startsWith("SHELL ")) process.stdout.write(`${message}\n`);
  });
  window.webContents.on("dom-ready", () => {
    void window.webContents.executeJavaScript(probe);
  });
  createInterface({ input: process.stdin }).on("line", (script) => {
    void window.webContents.executeJavaScript(script);
  });
  void window.loadURL(url);
});

app.on("window-all-closed", () => app.quit());
