import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.LATERDOG_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping desktop banners UI e2e: set LATERDOG_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("a finished turn in a window nobody is looking at posts a replyable banner, and its Reply lands once in the dog's conversation", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-laterdog.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;

    await evaluate("(() => { location.search = '?desktopBanners'; return true; })()").catch(() => undefined);
    await expect.poll(() => evaluate("Boolean(window.recordingBanners && document.querySelector('textarea[aria-label^=\"Message \"]'))").catch(() => false), { timeout: 30_000 }).toBe(true);
    await evaluate("(() => { document.hasFocus = () => false; return true; })()");
    const composer = () => evaluate("document.querySelector('textarea[aria-label^=\"Message \"]')?.getAttribute('aria-label')");
    const before = await composer();

    await runControlLaterDog(["send", "--bot", info!.botId, "--text", "write the report", "--url", info!.url]);
    const doneBanners = async () => JSON.parse(await evaluate("JSON.stringify(window.recordingBanners.shown.filter((banner) => banner.kind === 'done'))"));
    await expect.poll(async () => (await doneBanners()).length, { timeout: 60_000 }).toBe(1);
    const [banner] = await doneBanners();
    expect(banner).toMatchObject({ botId: info!.botId, title: "Pepper finished", replyable: true, silent: false });
    await runControlLaterDog(["wait", "--bot", info!.botId, "--timeout", "60", "--url", info!.url]);

    const reply = JSON.stringify({ botId: banner.botId, threadId: banner.threadId, text: "Send it to Sam", sendId: "banner-reply-0001" });
    const repliesLanded = () => evaluate(`fetch('/api/threads/${banner.threadId}/messages').then((res) => res.json()).then(({ messages }) => messages.filter((message) => message.role === 'user' && message.sendId === 'banner-reply-0001' && message.text === 'Send it to Sam').length)`);
    await evaluate(`(() => { window.recordingBanners.reply(${reply}); return true; })()`);
    await expect.poll(repliesLanded, { timeout: 30_000 }).toBe(1);
    await runControlLaterDog(["wait", "--bot", info!.botId, "--timeout", "60", "--url", info!.url]);
    expect(await composer()).toBe(before);

    await evaluate(`(() => { window.recordingBanners.reply(${reply}); return true; })()`);
    await runControlLaterDog(["wait", "--bot", info!.botId, "--timeout", "60", "--url", info!.url]);
    expect(await repliesLanded()).toBe(1);

    await evaluate(`(() => { window.recordingBanners.open(${JSON.stringify({ botId: banner.botId, threadId: banner.threadId })}); return true; })()`);
    await expect.poll(composer, { timeout: 10_000 }).toBe("Message Pepper");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 240_000 : 720_000);
