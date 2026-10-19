import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.LATERDOG_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

(enabled ? it : it.skip)("coordinates from the real composer and opens the read-only exchange from the inline receipt", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "laterdog-direct-ui-plan-"));
  const planPath = join(temporary, "plan.json");
  writeFileSync(planPath, "{}");
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-laterdog.ts", "ui", "launch"], {
    cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_ROOM_PLAN: planPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  child.on("error", caught => { error += caught.message; });
  let info: { ui: string; url: string; botId: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(error);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(info.url + path, body === undefined ? {} : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const click = async (name: string, role = "button") => {
      const refs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
      const match = Object.entries(refs).find(([, entry]) => entry.role === role && (entry.name.endsWith(name) || entry.name.startsWith(`${name}:`)));
      expect(match).toBeDefined();
      return ui("click", "--ref", "@" + match![0]);
    };
    const lead = (await api("/api/bots", { name: "Engineer", title: "Implementation", section: "" })).bot;
    const gateFile = join(temporary, "finish-teammate");
    writeFileSync(planPath, JSON.stringify({
      [info.botId]: { steps: [{ arguments: { bot_ids: [lead.id], request_key: "review", message: "Check the fixture CSV export" } }], reply: "Assigned", resumeReply: "Engineer checked the fixture CSV export" },
      [lead.id]: { gateFile, reply: "CSV export checked in my separate task" },
    }));
    await ui("flag", "--set", "features.showToolCalls=false");
    await ui("type", "--name", "Message Pepper", "--text", "Please have Engineer check the CSV export and report back");
    await ui("press", "--keys", "Enter");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Other dogs working");
    const waiting = (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === info.botId);
    expect(waiting).toMatchObject({ busy: false, waitingForTeammates: true });
    const controls = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
    expect(Object.values(controls).some(control => control.role === "textbox" && control.name === "Message Pepper")).toBe(true);
    await ui("screenshot", "--out", info.logPath + ".teammates-working.png");
    writeFileSync(gateFile, "complete fixture work");
    await ui("wait-settle", "--timeout", "60");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Engineer checked the fixture CSV export");
    const exchangeLabel = "Read what Pepper and Engineer said to each other";
    expect(await snapshot()).toContain(exchangeLabel);
    const state = await api("/api/bots");
    const parent = state.bots.find((bot: any) => bot.id === info.botId);
    const receipt = parent.messages.find((message: any) => message.tool?.name === "Sent to Engineer");
    expect(receipt.threadRef).toBeUndefined();
    const exchange = state.groups.find((group: any) => group.id === receipt.comm.groupId);
    expect(exchange).toMatchObject({ dm: true, memberIds: [info.botId, lead.id] });
    expect(receipt.comm).toMatchObject({ threadId: exchange.threadId, withBotId: lead.id, direction: "to" });
    const screenshot = info.logPath + ".direct-coordination.png";
    await ui("screenshot", "--out", screenshot);
    await click(exchangeLabel);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("The dogs wrote these to each other. You can read along but not reply here.");
    const opened = await snapshot();
    expect(opened).toContain("Check the fixture CSV export");
    expect(opened).toContain("CSV export checked in my separate task");
    const exchangeScreenshot = info.logPath + ".direct-coordination-exchange.png";
    await ui("screenshot", "--out", exchangeScreenshot);
    const evidence = { source: parent.messages, receipt, exchange, final: opened, screenshot, exchangeScreenshot };
    writeFileSync(info.logPath + ".direct-coordination.json", JSON.stringify(evidence, null, 2));
    console.log("Direct coordination UI evidence:", info.logPath + ".direct-coordination.json");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temporary);
  }
}, 240_000);
