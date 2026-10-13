const DONE_FRAGMENT = "#done";
const PILL_TOP = 14;
const PILL_HEIGHT = 40;
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const LABEL_CHARS = 40;

function pillText(raw, fallback) {
  if (Object.prototype.toString.call(raw) !== "[object String]") return fallback;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS).trim();
  return text || fallback;
}

function desktopViewerPill(raw) {
  if (Object.prototype.toString.call(raw) !== "[object Object]") return null;
  return {
    label: pillText(raw.label, "You're in control"),
    done: pillText(raw.done, "I'm done"),
  };
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function desktopViewerPillPage(pill) {
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    "<style>",
    "html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}",
    "body{display:flex;font:500 13px/1 -apple-system,BlinkMacSystemFont,\"Segoe UI\",system-ui,sans-serif}",
    ".pill{box-sizing:border-box;flex:1;display:flex;align-items:center;gap:10px;padding:0 5px 0 14px;border-radius:999px;",
    "background:rgba(24,24,27,.92);color:#fafafa;box-shadow:0 0 0 .5px rgba(255,255,255,.14) inset}",
    ".dot{width:7px;height:7px;flex:none;border-radius:50%;background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.22)}",
    ".label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "a{flex:none;padding:8px 13px;border-radius:999px;background:#fafafa;color:#18181b;text-decoration:none;font-weight:600}",
    "a:hover{background:#fff}a:focus-visible{outline:2px solid #60a5fa;outline-offset:2px}",
    "</style></head><body>",
    `<div class="pill" role="status"><span class="dot"></span><span class="label">${escapeHtml(pill.label)}</span>`,
    `<a href="${DONE_FRAGMENT}">${escapeHtml(pill.done)}</a></div>`,
    "</body></html>",
  ].join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function desktopViewerPillDone(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "data:" && url.hash === DONE_FRAGMENT;
  } catch {
    return false;
  }
}

function desktopViewerPillBounds(contentWidth, pill) {
  const wanted = Math.round(74 + (pill.label.length + pill.done.length) * 7.4);
  const width = Math.max(0, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, wanted), contentWidth - 24));
  return { x: Math.max(0, Math.round((contentWidth - width) / 2)), y: PILL_TOP, width, height: PILL_HEIGHT };
}

function attachDesktopViewerPill({ viewer, createView, pill }) {
  const view = createView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: false,
      webSecurity: true,
      partition: "laterdog-desktop-viewer-pill",
    },
  });
  const contents = view.webContents;
  try {
    view.setBackgroundColor("#00000000");
  } catch {}
  const place = () => {
    if (viewer.isDestroyed()) return;
    const [width] = viewer.getContentSize();
    view.setBounds(desktopViewerPillBounds(width, pill));
  };
  const finish = (target) => {
    if (desktopViewerPillDone(target) && !viewer.isDestroyed()) viewer.close();
  };
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, target) => {
    event.preventDefault();
    finish(target);
  });
  contents.on("did-navigate-in-page", (_event, target) => finish(target));
  viewer.contentView.addChildView(view);
  place();
  viewer.on("resize", place);
  viewer.once("closed", () => {
    try {
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    } catch {}
  });
  void Promise.resolve(contents.loadURL(desktopViewerPillPage(pill))).catch(() => {});
  return view;
}

module.exports = {
  attachDesktopViewerPill,
  desktopViewerPill,
  desktopViewerPillBounds,
  desktopViewerPillDone,
  desktopViewerPillPage,
};
