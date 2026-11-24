const LINGER_MS = 8000;

export function createLendingIndicator({ Tray, Menu, nativeImage, iconPath, onStop, onOpen, device = "computer", lingerMs = LINGER_MS }) {
  let tray = null;
  let hide = null;
  let doing = null;
  const live = () => Boolean(tray) && !tray.isDestroyed();
  const draw = () => {
    if (!live()) return;
    const line = doing ? `${doing.name} · ${doing.step}` : `My Cloud is using this ${device}`;
    tray.setToolTip(`later.dog: ${line}`);
    tray.setTitle?.(doing ? doing.name : "In use");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: "separator" },
      { label: `Turn off for this ${device}`, click: () => onStop() },
      { label: "later.dog Cloud settings…", click: () => onOpen() },
    ]));
  };
  const remove = () => {
    clearTimeout(hide);
    hide = null;
    doing = null;
    if (live()) tray.destroy();
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
      if (live()) return;
      tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
      tray.on("click", () => tray?.popUpContextMenu?.());
      draw();
    },
    describe(state) {
      const next = state && typeof state.name === "string" && typeof state.step === "string" ? { name: state.name, step: state.step } : null;
      if (next?.name === doing?.name && next?.step === doing?.step) return;
      doing = next;
      draw();
    },
    destroy: remove,
  };
}
