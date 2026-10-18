(async () => {
  if (location.pathname !== "/__threads.html") throw new Error("Use the isolated ui launch preview");
  const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const wait = async (check, label) => {
    for (let i = 0; i < 100; i += 1) {
      const found = check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const row = await wait(() => [...document.querySelectorAll('[role="button"]')].find((node) => node.textContent.startsWith("Pepper")), "Pepper's row");
  row.click();
  await settle();
  const actions = await wait(() => document.querySelector("[data-composer-actions]"), "the composer");
  const buttons = [...document.querySelectorAll("[data-call-button]")];
  const liveRequestsBefore = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/live/session")).length;
  const button = buttons[0];
  const result = {
    voiceButtons: buttons.length,
    inComposer: Boolean(button && actions.contains(button)),
    label: button?.getAttribute("aria-label") ?? null,
    route: button?.dataset.callRoute ?? null,
    modeMenu: Boolean(document.querySelector('[aria-label="Call mode"]')),
  };
  button?.click();
  await settle();
  const help = await wait(() => document.querySelector("[data-call-unavailable]"), "the Voice call unavailable note");
  result.unavailableText = help.textContent;
  result.keyField = Boolean(document.querySelector('input[aria-label="OpenAI API key for Live calls"]'));
  result.keyTitle = document.body.textContent.includes("Live calls use OpenAI GPT-Live");
  result.liveRequests = performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/live/session")).length - liveRequestsBefore;
  const expected = result.voiceButtons === 1 && result.inComposer && !result.modeMenu && !result.keyField && !result.keyTitle && result.liveRequests === 0
    && result.unavailableText.includes("Voice call unavailable");
  if (!expected) throw new Error(JSON.stringify(result));
  return result;
})()
