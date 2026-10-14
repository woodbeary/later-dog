const LINGER_MS = 8000;

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, device = "computer", lingerMs = LINGER_MS }) {
  let tray = null;
  let hide = null;
  const remove = () => {
    clearTimeout(hide);
    hide = null;
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  return {
    update({ lending, busy }) {
      if (!lending) return remove();
      if (!busy) {
        if (tray && !hide) { hide = setTimeout(remove, lingerMs); hide.unref?.(); }
        return;
      }
      clearTimeout(hide);
      hide = null;
      if (tray && !tray.isDestroyed()) return;
      tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
      tray.on("click", () => tray?.popUpContextMenu?.());
      tray.setToolTip(`later.dog: My Cloud is using this ${device}`);
      tray.setTitle?.("In use");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: `My Cloud is using this ${device}`, enabled: false },
        { type: "separator" },
        { label: `Turn off for this ${device}`, click: () => onStop() },
        { label: "later.dog Cloud settings…", click: () => onOpen() },
      ]));
    },
    destroy: remove,
  };
}
