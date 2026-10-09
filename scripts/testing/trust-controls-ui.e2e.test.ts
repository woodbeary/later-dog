// Real renderer, disposable fake engine and browser profile only.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.LATERDOG_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
interface FixtureInfo { ui: string; url: string; logPath: string }
interface SavedBot { id: string; name: string }

describe("trust controls in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("refreshes receipts in Activity", async () => {
    let output = "", errors = "";
    let info!: FixtureInfo;
    const launcher = new URL("./control-laterdog-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi(['--tool-calls', '[{"name":"Bash","input":{"command":"echo fixture"},"ok":true}]']); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { errors += String(chunk); });
    child.on("error", error => { errors += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${errors}`);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 300_000, interval: 250 }).toBe(true);

    const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const click = (name: string) => ui("click", "--name", name);
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then(response => response.json())).bots;
    const bot = (await bots()).find(candidate => candidate.name === "Pepper")!;
    expect(bot).toBeDefined();

    await click("More");
    await click("Activity");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Nothing yet.");
    await runControlLaterDog(["send", "--bot", bot.id, "--text", "Run the harmless fixture tool.", "--url", info.url]);
    await runControlLaterDog(["wait", "--bot", bot.id, "--timeout", "20", "--url", info.url]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Ran a command");
    await ui("screenshot", "--out", `${info.logPath}.activity.png`);
    await click("Close Activity");
  }, 420_000);
});
