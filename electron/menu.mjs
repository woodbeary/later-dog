import { Menu, app } from "electron";

export function buildApplicationMenu({ onOpenSettings, sessionItems = [] }) {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: "about" }, { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: () => onOpenSettings() }, ...sessionItems, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    isMac ? { role: "viewMenu" } : { role: "viewMenu", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools", accelerator: "F12" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
