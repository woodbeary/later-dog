(async () => {
  if (location.pathname !== "/__threads.html") throw new Error("Use the isolated ui launch preview");
  const asset = (part) => performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes(part)).at(-1);
  const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const wait = async (check, label) => {
    for (let i = 0; i < 100; i += 1) {
      const found = check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const speech = { starts: 0, stops: 0, transcript: null, end: null };
  const mac = {
    remote: false,
    host: { platform: "darwin", label: "macOS", session: "unknown", packaged: false },
    windowChrome: "mac-inset",
    screenPreview: { available: false, interaction: "none" },
    dictation: { available: true, engine: "apple-speech", onDevice: true },
    localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
  };
  window.laterdog = {
    platform: "darwin",
    getCapabilities: async () => mac,
    onCapabilitiesChanged: () => () => {},
    speechStart: async () => { speech.starts += 1; },
    speechStop: async () => { speech.stops += 1; return {}; },
    onSpeechTranscript: (cb) => { speech.transcript = cb; return () => { if (speech.transcript === cb) speech.transcript = null; }; },
    onSpeechEnd: (cb) => { speech.end = cb; return () => { if (speech.end === cb) speech.end = null; }; },
  };
  window.__voiceSpeech = speech;
  const [{ default: App }, react, client] = await Promise.all([
    import(asset("/src/App.tsx")),
    import(asset("deps/react.js")),
    import(asset("react-dom_client")),
  ]);
  const createElement = react.createElement ?? react.default.createElement;
  const createRoot = client.createRoot ?? client.default.createRoot;
  const old = document.getElementById("root");
  old.removeAttribute("id");
  old.style.display = "none";
  const fresh = document.createElement("div");
  fresh.id = "root";
  old.after(fresh);
  createRoot(fresh).render(createElement(App));
  const row = await wait(() => [...fresh.querySelectorAll('[role="button"]')].find((node) => node.textContent.startsWith("Pepper")), "Pepper's row");
  row.click();
  await settle();
  const mic = await wait(() => fresh.querySelector("[data-composer-mic]"), "the dictation button");
  const box = fresh.querySelector("textarea");
  const before = "Pack list:  ";
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, before);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  mic.click();
  await wait(() => speech.transcript, "dictation to start");
  const result = { voiceButtonRoute: fresh.querySelector("[data-call-button]")?.dataset.callRoute ?? null, listeningPlaceholder: box.placeholder, stopHint: mic.title };
  speech.transcript({ partial: true, text: "remind me to pack sunscreen" });
  await settle();
  result.whileListening = box.value;
  mic.focus();
  mic.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  result.afterEscape = box.value;
  result.restored = box.value === before;
  result.stopped = speech.stops > 0 && speech.transcript === null;
  result.micLabel = mic.getAttribute("aria-label");
  if (!result.restored || !result.stopped || result.whileListening !== "Pack list: remind me to pack sunscreen") throw new Error(JSON.stringify(result));
  return result;
})()
