const { app, BrowserWindow } = require("electron");

const url = process.argv[process.argv.length - 2];
const dog = process.argv[process.argv.length - 1];
const started = Date.now();

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const probe = `(() => {
    const dog = ${JSON.stringify(dog)};
    const tick = () => {
      const row = [...document.querySelectorAll('[data-tour="sidebar"] *, nav *, aside *')].find((node) => node.childElementCount === 0 && node.textContent.trim() === dog);
      const box = document.querySelector('textarea');
      if (row && !window.__clicked) { window.__clicked = true; row.click(); }
      const ready = box && (box.getAttribute('placeholder') || '').includes(dog);
      if (ready) { console.log('BENCH ready'); return; }
      setTimeout(tick, 25);
    };
    tick();
  })()`;
  window.webContents.on("console-message", (...args) => {
    const text = typeof args[2] === "string" ? args[2] : args[0]?.message;
    if (text === "BENCH ready") process.stdout.write(`READY ${Date.now() - started} ${process.pid}\n`);
  });
  window.webContents.on("dom-ready", () => void window.webContents.executeJavaScript(probe));
  void window.loadURL(url);
});
app.on("window-all-closed", () => app.quit());
