import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PILL_SIZE = Object.freeze({ width: 460, height: 64 });
const PILL_TOP = 6;
const FADE_MS = 240;

export function presenceDisplay(screen, point) {
  return point ? screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }) : screen.getPrimaryDisplay();
}

export function pillBounds(display) {
  const area = display.workArea;
  return {
    x: Math.round(area.x + (area.width - PILL_SIZE.width) / 2),
    y: Math.round(area.y + PILL_TOP),
    width: PILL_SIZE.width,
    height: PILL_SIZE.height,
  };
}

export function createPresenceOverlay({ BrowserWindow, screen, onStop, protect = true, dir = HERE, platform = process.platform }) {
  let pill = null;
  let glow = null;
  let latest = null;
  let hiding = null;
  const loaded = new WeakSet();
  const live = win => Boolean(win) && !win.isDestroyed();
  const send = (win, state) => { if (live(win) && loaded.has(win)) win.webContents.send("presence:state", state); };
  const make = (page, size) => {
    const win = new BrowserWindow({
      ...size, show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, acceptFirstMouse: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: { preload: path.join(dir, "presence-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    win.setContentProtection(protect);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("did-finish-load", () => { loaded.add(win); send(win, win === glow ? (latest?.screen ? latest : null) : latest); });
    void win.loadFile(path.join(dir, "presence", page)).catch(() => {});
    return win;
  };
  const appear = win => { if (!win.isVisible()) win.showInactive(); };
  const hideSoon = () => {
    clearTimeout(hiding);
    hiding = setTimeout(() => {
      hiding = null;
      if (!latest && live(pill)) pill.hide();
      if (!latest?.screen && live(glow)) glow.hide();
    }, FADE_MS);
    hiding.unref?.();
  };
  return {
    render(state) {
      latest = state ?? null;
      if (!latest) {
        send(pill, null);
        send(glow, null);
        return hideSoon();
      }
      const display = presenceDisplay(screen, latest.point);
      if (!live(pill)) pill = make("pill.html", PILL_SIZE);
      pill.setBounds(pillBounds(display));
      send(pill, latest);
      appear(pill);
      if (latest.screen) {
        clearTimeout(hiding);
        hiding = null;
        if (!live(glow)) glow = make("glow.html", { width: display.workArea.width, height: display.workArea.height });
        glow.setBounds(display.workArea);
        send(glow, latest);
        appear(glow);
      } else if (live(glow) && glow.isVisible()) {
        send(glow, null);
        hideSoon();
      }
    },
    hover(sender, inside) {
      if (live(pill) && sender === pill.webContents) pill.setIgnoreMouseEvents(!inside, { forward: true });
    },
    stop(sender) {
      if (!live(pill) || sender !== pill.webContents || !latest) return false;
      onStop();
      return true;
    },
    destroy() {
      clearTimeout(hiding);
      for (const win of [pill, glow]) if (live(win)) win.destroy();
      pill = null;
      glow = null;
      latest = null;
    },
  };
}
