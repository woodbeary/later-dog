import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AppConfig } from "../config.ts";
import { cloudComputerRpc } from "../cloud-computer-tools.ts";
import { boxScreenExec, readBoxScreens, screensOnBox, setBoxScreen } from "./box-screen.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-box-screen-")); scratch.push(dir); return dir; };

it("keeps every dog on its own computer until the owner switches one to the box", () => {
  const file = join(folder(), "laterdog", "box-screens.json");
  expect(screensOnBox(file, "dog-1")).toBe(false);
  setBoxScreen(file, "dog-1", true);
  expect(screensOnBox(file, "dog-1")).toBe(true);
  expect(screensOnBox(file, "dog-2")).toBe(false);
  setBoxScreen(file, "dog-1", false);
  expect([...readBoxScreens(file)]).toEqual([]);
  expect(screensOnBox(file, "../x")).toBe(false);
});

it("runs a screen command on the dog's own desktop in the box", async () => {
  const dir = folder();
  process.env.LATERDOG_COMPUTERS_API = "https://computers.example.test/v1";
  process.env.LATERDOG_COMPUTERS_KEY_FILE = join(dir, "key");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "key"), "ldc_stand_in_key_for_tests_only_000000000000000");
  const seen: Array<{ url: string; body: unknown }> = [];
  const send = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout: "done", stderr: "" }), { status: 200 });
  }) as typeof fetch;
  const result = await boxScreenExec("dog-1", send)("scrot x", new AbortController().signal);
  expect(result).toEqual({ ok: true, exitCode: 0, stdout: "done", stderr: "" });
  expect(seen[0]?.url).toBe("https://computers.example.test/v1/box/desktops/dog-1/run");
  expect(seen[0]?.body).toMatchObject({ command: "scrot x" });
  const refused = await boxScreenExec("dog-1", (async () => new Response(JSON.stringify({ error: { message: "The personal box is starting" } }), { status: 503 })) as typeof fetch)("x", new AbortController().signal);
  expect(refused).toMatchObject({ ok: false, stderr: "The personal box is starting" });
  delete process.env.LATERDOG_COMPUTERS_API;
  delete process.env.LATERDOG_COMPUTERS_KEY_FILE;
});

it("sends screen tools to the box, even without a cloud computer, and keeps exec on the dog's computer", async () => {
  const commands: string[] = [];
  const screen = async (command: string) => { commands.push(command); return { ok: true, exitCode: 0, stdout: "", stderr: "" }; };
  const deps = { cfg: {} as AppConfig, boxId: () => undefined, gate: async () => ({ held: false }), assertActive: () => {}, signal: new AbortController().signal, screen };
  const clicked = await cloudComputerRpc({ method: "tools/call", params: { name: "click", arguments: { x: 10, y: 20 } } }, deps);
  expect("isError" in clicked && clicked.isError).toBeFalsy();
  expect(commands[0]).toContain("xdotool");
  const ran = await cloudComputerRpc({ method: "tools/call", params: { name: "exec", arguments: { command: "ls" } } }, deps);
  expect(ran).toMatchObject({ isError: true });
  expect(commands).toHaveLength(1);
});
