import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeTempDir } from "./cleanup.ts";
import { runRoomHandoffAgent } from "./room-handoff-agent.ts";

async function withMcp(script: string, test: (run: (message?: unknown) => Promise<string>, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-handoff-process-"));
  const config = join(dir, "mcp.json");
  const prompt = join(dir, "system.txt");
  const plan = join(dir, "plan.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { agents: {
    command: process.execPath, args: ["-e", script], env: { LATERDOG_BOT_ID: "fixture", FIXTURE_HOME: dir },
  } } }));
  writeFileSync(prompt, "Only this disposable test fixture.");
  writeFileSync(plan, JSON.stringify({ fixture: { reply: "Completed fixture" } }));
  try { await test((message) => runRoomHandoffAgent(["--mcp-config", config, "--append-system-prompt-file", prompt], plan, message), dir); }
  finally { await removeTempDir(dir); }
}

it("rejects malformed MCP output rather than crashing the provider process", () => withMcp(
  'process.stdout.write("not json\\n"); setInterval(() => {}, 1000);',
  async run => { await expect(run()).rejects.toThrow("Fixture MCP returned malformed JSON"); },
));

it("rejects an unexpected MCP exit without waiting for a pending call to time out", () => withMcp(
  'process.stdin.once("data", () => process.exit(7));',
  async run => { await expect(run()).rejects.toThrow("Fixture MCP exited unexpectedly: 7"); },
));

it("reaps the MCP process even if it ignores graceful shutdown", () => withMcp(`
  require("node:fs").writeFileSync(require("node:path").join(process.env.FIXTURE_HOME, "pid"), String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  });
`, async (run, dir) => {
  await expect(run()).resolves.toBe("Completed fixture");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}));

it("keeps the context already received by a continuing native fixture session", () => withMcp(`
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  });
`, async (run, dir) => {
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ fixture: { turns: [
    { reply: "Saved the first checkpoint." },
    { expectContextIncludes: ["Repair the original output.", "Continue from the saved checkpoint."], reply: "Verified the repair." },
  ] } }));
  await expect(run({ message: { content: "Repair the original output." } })).resolves.toBe("Saved the first checkpoint.");
  await expect(run({ message: { content: "Continue from the saved checkpoint." } })).resolves.toBe("Verified the repair.");
}));

it("restores the context of a resumed native fixture session without mixing a fresh session", () => withMcp(`
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  });
`, async (_run, dir) => {
  const plan = join(dir, "plan.json");
  writeFileSync(plan, JSON.stringify({ fixture: { turns: [
    { reply: "Saved the original request." },
    { expectContextIncludes: ["Repair the original output.", "Continue the repair."], reply: "Verified the resumed repair." },
    { expectContextIncludes: ["Repair the original output."], reply: "A fresh session must not see the old request." },
  ] } }));
  const native = async (cursor: string, resume: boolean, text: string) => {
    const argv = ["--mcp-config", join(dir, "mcp.json"), "--append-system-prompt-file", join(dir, "system.txt"), resume ? "--resume" : "--session-id", cursor];
    const input = JSON.stringify({ argv, plan, prompt: { message: { content: text } } });
    const source = `import { runRoomHandoffAgent } from ${JSON.stringify(new URL("./room-handoff-agent.ts", import.meta.url).href)}; const input = ${input}; process.stdout.write(await runRoomHandoffAgent(input.argv, input.plan, input.prompt));`;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source]);
    return result.stdout;
  };
  await expect(native("kept-session", false, "Repair the original output.")).resolves.toBe("Saved the original request.");
  await expect(native("kept-session", true, "Continue the repair.")).resolves.toBe("Verified the resumed repair.");
  await expect(native("fresh-session", false, "Start an unrelated request.")).rejects.toThrow("Missing conversation context: Repair the original output.");
}));
