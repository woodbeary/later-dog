// Real model picker + private desktop confirmation, against the disposable
// approval fixture. Provider replies are synthetic; no account is contacted.
const { BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function verifyModelSwitch({ root, url, api, until, grant }) {
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Model switch fixture", modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).body.bot;
  await grant(bot.id, "custom");
  const sibling = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Unrelated custom conversation" })).body.task;
  const selected = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Research brief" })).body.task;
  const read = async () => (await api("/api/bots?messages=0")).body.bots.find(candidate => candidate.id === bot.id);
  const selection = { instanceId: "claude", model: "claude-sonnet-5" };
  // Neither changing the mode separately nor combining fields can bypass
  // the Custom boundary from a bot-accessible HTTP connection.
  assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { approvalMode: "ask", modelSelection: selection })).status, 403);
  assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { resetApprovalToAsk: true, modelSelection: selection })).status, 403);
  const preview = await mountPreview({ info: { url } }, { entry: "/src/testing/thread-approvals.tsx", route: "/__thread-approvals.html", title: "Isolated model switching", logLevel: "silent" });
  const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: join(root, "scripts/testing/approval-preview-preload.cjs"), contextIsolation: true, sandbox: true } });
  const calls = [];
  ipcMain.handle("fixture:thread-approval", (event, botId, mode, options) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(botId, bot.id);
    assert.equal(mode, "ask");
    assert.equal(options.threadId, selected.threadId);
    calls.push(options);
    return grant(botId, mode, options);
  });
  const evaluate = js => window.webContents.executeJavaScript(js).catch(error => { throw new Error(`${error.message}\nExpression: ${js}`); });
  const text = () => evaluate("document.body.innerText");
  const click = name => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)} || b.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Missing enabled button: ' + ${JSON.stringify(name)}); button.click(); return true; })()`);
  const inPicker = selector => `document.querySelector(${JSON.stringify(`[data-model-picker-content] ${selector}`)})`;
  const press = selector => evaluate(`(() => { const node = ${inPicker(selector)}; if (!node || node.disabled) throw new Error('Missing enabled control: ' + ${JSON.stringify(selector)}); node.click(); return true; })()`);
  const modelRow = label => `[...document.querySelectorAll('[data-model-picker-content] [data-simple-models] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const settle = () => evaluate(`Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})))
    .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
  const capture = async name => {
    await settle();
    writeFileSync(join(evidence, name), (await window.webContents.capturePage()).toPNG());
  };
  const resize = async (width, height) => {
    window.setSize(width, height);
    await until(() => evaluate(`innerWidth === ${width}`));
    await settle();
  };
  const openPicker = async () => { await evaluate("document.querySelector('[data-tour=model]').click(); true"); await until(() => evaluate("!!document.querySelector('[data-model-picker-content]')")); };
  const closePicker = async () => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => evaluate("!document.querySelector('[data-model-picker-content]')"));
  };
  const confirmation = async () => {
    await until(async () => (await text()).includes("Switch model and reset to Heel?"));
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Cancel");
  };
  const evidence = join(root, ".laterdog-scratch/verify-evidence/model-switch");
  mkdirSync(evidence, { recursive: true });
  try {
    await window.loadURL(`${preview.previewUrl}?bot=${bot.id}&model-switch=1`);
    await until(() => evaluate("!!document.querySelector('[data-tour=model]')"));
    await openPicker();
    const instances = (await api("/api/instances")).body.instances;
    assert.equal(instances.find(instance => instance.instanceId === "claude-signed-out").snapshot.authenticated, false);
    assert.notEqual(instances.find(instance => instance.instanceId === "missing-codex").snapshot.state, "available");
    assert.equal(await evaluate(`Boolean(${inPicker("[data-simple-model-pane]")})`), true);
    assert.equal(await evaluate(`Boolean(${inPicker('[aria-label="Apply model changes to"]')})`), false);
    assert.equal(await evaluate(`Boolean(${inPicker('[data-simple-provider="missing-codex"]')} || ${inPicker('[data-account="missing-codex"]')})`), false);
    assert.equal((await text()).includes("Missing provider fixture"), false);
    assert.match(await evaluate(`${inPicker('[data-account="claude-signed-out"]')}.textContent`), /Not signed in/);
    await press('[data-simple-provider="claude"]');
    await until(() => evaluate(`Boolean(${modelRow("Claude Sonnet 5")})`));
    await capture("configured-providers.png");
    for (const [width, height] of [[1280, 800], [1000, 600], [800, 480], [390, 844]]) {
      await resize(width, height);
      const geometry = await evaluate(`(() => {
        const panel = document.querySelector('[data-model-picker-content]');
        const rect = panel.getBoundingClientRect();
        const models = panel.querySelector('[data-simple-models]').getBoundingClientRect();
        const row = panel.querySelector('[data-simple-models] [role=group] button').getBoundingClientRect();
        const band = panel.querySelector('[data-simple-effort-band]').getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight,
          modelsHeight: models.height, rowHeight: row.height, bandBottom: band.bottom };
      })()`);
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry));
      assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
      assert.ok(geometry.bandBottom <= geometry.bottom + 0.5, JSON.stringify(geometry));
      assert.ok(geometry.modelsHeight >= 2 * geometry.rowHeight, JSON.stringify(geometry));
      await capture(`model-picker-${width}x${height}.png`);
    }
    await resize(1100, 850);
    await evaluate(`${modelRow("Claude Sonnet 5")}.click(); true`);
    await confirmation();
    await click("Cancel");
    assert.equal(calls.length, 0);
    const cancelled = await read();
    const cancelledTask = cancelled.tasks.find(task => task.threadId === selected.threadId);
    assert.equal(cancelledTask.approvalMode, "custom");
    assert.equal(cancelledTask.modelSelection.instanceId, "codex");
    assert.equal(cancelled.modelSelection.instanceId, "codex");
    await openPicker();
    await press('[data-account="claude-signed-out"]');
    await until(async () => (await text()).includes("Signed-out fixture needs to be set up before you can use it."));
    assert.equal(await evaluate(`Boolean(${inPicker("[data-simple-set-up]")})`), true);
    assert.equal(await evaluate(`Boolean(${modelRow("Claude Sonnet 5")})`), false);
    assert.equal(calls.length, 0);
    await capture("signed-out-account.png");
    await press('[data-account="claude"]');
    await confirmation();
    assert.ok((await text()).includes("Every thread that uses the dog's model switches too"));
    await resize(390, 844);
    assert.equal(await evaluate("(() => { const r = document.querySelector('[role=alertdialog]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), true);
    await capture("default-confirmation.png");
    await click("Switch with Heel");
    await until(async () => (await read()).modelSelection.instanceId === "claude");
    assert.deepEqual(calls, [{ threadId: selected.threadId, modelSelection: selection, updateBotDefault: true }]);
    const after = await read();
    assert.equal(after.approvalMode, "ask");
    for (const thread of [selected, sibling]) {
      const moved = after.tasks.find(task => task.threadId === thread.threadId);
      assert.equal(moved.modelSelection.instanceId, "claude");
      assert.equal(moved.approvalMode, "ask");
    }
    await resize(1100, 850);
    const newThread = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Uses the new default" })).body.task;
    assert.equal(newThread.modelSelection.instanceId, "claude");
    assert.equal(newThread.approvalMode, "ask");
    await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "POST", {});
    await until(async () => (await read()).threadId === selected.threadId);
    await evaluate("document.querySelector('textarea').focus(); true");
    window.webContents.insertText("Draft three acceptance criteria for the engineering handoff.");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(async () => !(await read()).busy && (await text()).includes("hello from fake claude"));
    await capture("after-send.png");
    const localModel = instances.find(instance => instance.instanceId === "codex").models.options.find(option => option.custom && option.id.includes("fixture-local"));
    assert.ok(localModel, "Fixture includes a configured local model alongside Codex cloud models");
    assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { modelSelection: { instanceId: "codex", model: localModel.id } })).status, 200);
    await until(() => evaluate(`document.querySelector('[data-tour=model]').textContent.includes(${JSON.stringify(localModel.label)})`));
    await openPicker();
    await press('[data-simple-provider="claude"]');
    await closePicker();
    await openPicker();
    await settle();
    await until(() => evaluate(`[...document.querySelectorAll('[data-model-picker-content] [data-simple-models] button[aria-pressed=true]')].some(button => button.textContent.includes(${JSON.stringify(localModel.label)}))`));
    assert.equal(await evaluate(`${inPicker('[data-simple-provider="codex"]')}.getAttribute('aria-pressed')`), "true");
    await capture("reopened-local-model.png");
    console.log(JSON.stringify({ modelSwitch: true, simplePicker: true, missingProviderHidden: true, signedOutAccountShowsSetUp: true, customHttpRefused: true, cancelPreservedSettings: true,
      accountSwitchConfirmed: true, dogDefaultUpdated: true, followingThreadsMoved: true, newThreadUsesDefault: true,
      sentAfterSwitch: true, narrowLayout: true, selectedLocalModelOnReopen: true, providerReplies: "offline fake CLI", evidence }));
  } finally {
    ipcMain.removeHandler("fixture:thread-approval");
    window.destroy();
    await preview.close();
  }
};
