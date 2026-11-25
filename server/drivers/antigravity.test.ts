import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import {
  ANTIGRAVITY_FALLBACK_MODELS,
  AntigravityDriver,
  antigravityCatalog,
  antigravityCli,
  antigravityHome,
  antigravityMode,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const scratchDirs: string[] = [];
const instances: ProviderInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const dir of scratchDirs.splice(0)) await removeTempDir(dir);
});

function scratch(): string {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "laterdog-antigravity-"));
  scratchDirs.push(dir);
  return dir;
}

async function antigravity(dir: string, environment: Record<string, string> = {}, instanceId = "antigravity") {
  const auth = join(dir, "signed-in");
  if (!existsSync(auth) && environment.FAKE_ACP_SIGNED_OUT !== "1") writeFileSync(auth, "yes\n");
  const instance = await AntigravityDriver.create({
    instanceId,
    displayName: "Antigravity",
    enabled: true,
    environment: {
      HOME: dir,
      FAKE_ACP_DUMP: join(dir, "dump.json"),
      FAKE_ACP_RPC_DUMP: join(dir, "rpc.json"),
      FAKE_ACP_AGENT_NAME: "Antigravity ACP Server",
      FAKE_ACP_AUTH_FILE: auth,
      ...environment,
    },
    config: { cli: FAKE_CLI, fullAuto: false },
  });
  instances.push(instance);
  return instance;
}

async function run(instance: ProviderInstance, turn: Omit<SendTurnInput, "threadId"> & { threadId?: string }) {
  const recorder = recordEvents(instance.adapter);
  try {
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-agy", ...turn });
    return await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 20_000);
  } finally {
    recorder.stop();
  }
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const configCalls = (dir: string): Array<{ method: string; params: Record<string, unknown> }> =>
  existsSync(join(dir, "dump.json.config.json")) ? json(join(dir, "dump.json.config.json")) : [];

describe("Antigravity on the official agy", () => {
  it("offers Google's installer and starts with one default choice and no hard-coded model", () => {
    expect(AntigravityDriver.driverKind).toBe("antigravityAgent");
    expect(AntigravityDriver.metadata.displayName).toBe("Antigravity");
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: false, workspace: undefined });
    expect(AntigravityDriver.install?.command?.darwin).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    expect(AntigravityDriver.install?.command?.linux).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
    expect(AntigravityDriver.install?.managed).toBeUndefined();
    expect(ANTIGRAVITY_FALLBACK_MODELS).toEqual({ default: "default", options: [{ id: "default", label: "Default" }] });
    expect(AntigravityDriver.models).toEqual(ANTIGRAVITY_FALLBACK_MODELS);
  });

  it("keeps the Mac's own agy state and gives Linux file token storage, no updater and one state folder", () => {
    expect(antigravityHome({ HOME: "/Users/me" }, "darwin")).toEqual({ args: [], env: {} });
    expect(antigravityHome({ HOME: "/data" }, "linux")).toEqual({
      args: ["--gemini-dir", "/data/.gemini"],
      env: { AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true", AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
    });
  });

  it("runs the configured agy, else agy on PATH, else the installer's folder", () => {
    const dir = scratch();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "agy"), "#!/bin/sh\n");
    chmodSync(join(bin, "agy"), 0o755);
    expect(antigravityCli("/opt/google/agy", { PATH: bin, HOME: dir })).toBe("/opt/google/agy");
    expect(antigravityCli("agy", { PATH: `${join(dir, "none")}${delimiter}${bin}`, HOME: dir })).toBe(join(bin, "agy"));
    expect(antigravityCli("agy", { PATH: join(dir, "none"), HOME: dir })).toBe(join(dir, ".local", "bin", "agy"));
  });

  it("starts `agy acp` with its own state folder, asks for terminal sign-in support and never authenticates", async () => {
    const dir = scratch();
    const instance = await antigravity(dir);
    expect(await run(instance, { text: "hi", cwd: dir })).toMatchObject({ ok: true });
    const seen = json(join(dir, "dump.json"));
    expect(seen.argv).toEqual(["acp", ...antigravityHome({ HOME: dir }).args]);
    expect(seen.env).toMatchObject(antigravityHome({ HOME: dir }).env);
    for (const key of ["BROWSER", "GEMINI_HOME", "AGY_ACP_FORCE_FILE_STORAGE"]) expect(seen.env[key], key).toBeUndefined();
    expect(json(join(dir, "dump.json.initialize.json")).clientCapabilities.auth).toEqual({ terminal: true });
    expect(json(join(dir, "rpc.json"))).not.toContain("authenticate");
  });

  it("hands later.dog's own tools to agy as stdio servers and adds --process-per-session only for an http server", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_HTTP_PER_SESSION: "1" });
    const agents = { command: "node", args: ["agents.js"], env: { LATERDOG_TOKEN: "t" } };
    await run(instance, { text: "hi", cwd: dir, integrations: { agents } });
    expect(json(join(dir, "dump.json")).argv).not.toContain("--process-per-session");
    expect(json(join(dir, "dump.json.mcp.json"))).toContainEqual({ name: "agents", command: "node", args: ["agents.js"], env: [{ name: "LATERDOG_TOKEN", value: "t" }] });
    const remote = { type: "http" as const, url: "https://mcp.example.test/mcp", headers: {} };
    await run(instance, { threadId: "t-http", text: "hi", cwd: dir, integrations: { agents, custom: { remote } } });
    expect(json(join(dir, "dump.json")).argv).toEqual(["acp", ...antigravityHome({ HOME: dir }).args, "--process-per-session"]);
    expect(json(join(dir, "dump.json.mcp.json"))).toContainEqual({ type: "http", name: "remote", url: remote.url, headers: [] });
  });

  it("continues a chat with session/resume and passes the dog's other folders", async () => {
    const dir = scratch();
    const other = join(dir, "dog-folder");
    mkdirSync(other);
    const instance = await antigravity(dir, { FAKE_ACP_ADDITIONAL_DIRECTORIES: "1" });
    await run(instance, { text: "hi", cwd: dir, extraFolders: [other] });
    expect(json(join(dir, "dump.json.session.json"))).toMatchObject({ cwd: dir, additionalDirectories: [other] });
    await run(instance, { threadId: "t-again", text: "more", cwd: dir, extraFolders: [other], resumeCursor: "fake-acp-session" });
    expect(json(join(dir, "dump.json.resume.json"))).toMatchObject({ sessionId: "fake-acp-session", cwd: dir, additionalDirectories: [other] });
    expect(json(join(dir, "rpc.json"))).toContain("session/resume");
    expect(json(join(dir, "rpc.json"))).not.toContain("session/load");
  });

  it("sends pictures to agy as image blocks", async () => {
    const dir = scratch();
    const picture = join(dir, "dot.png");
    writeFileSync(picture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const instance = await antigravity(dir, { FAKE_ACP_IMAGE_CAPABILITY: "1", FAKE_ACP_DUMP_PROMPT: "1" });
    await run(instance, { text: "what is this", cwd: dir, images: [{ path: picture, mime: "image/png", bytes: 70 }] });
    expect(json(join(dir, "dump.json.prompt.json"))).toContainEqual({ type: "image", mimeType: "image/png", data: readFileSync(picture).toString("base64") });
  });

  it("maps Ask, Auto-accept edits and Full onto the modes the session offers", () => {
    const all = ["default", "accept-edits", "auto", "plan"];
    expect(antigravityMode("ask", all)).toBe("default");
    expect(antigravityMode(undefined, all)).toBe("default");
    expect(antigravityMode("edits", all)).toBe("accept-edits");
    expect(antigravityMode("full", all)).toBe("auto");
    expect(antigravityMode("full", ["default", "accept-edits", "plan"])).toBe("default");
    expect(antigravityMode("edits", ["default", "plan"])).toBe("default");
    expect(antigravityMode("ask", [])).toBeNull();
  });

  it("sets the session mode for every turn and never asks agy for yolo or auto_edit", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_MODES: "default,accept-edits,auto,plan" });
    for (const approvalMode of ["edits", "full", "ask"] as const) {
      expect(await run(instance, { text: "go", cwd: dir, approvalMode, resumeCursor: "fake-acp-session" })).toMatchObject({ ok: true });
    }
    const prompts = readFileSync(join(dir, "dump.json.prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(prompts.map((prompt) => prompt.mode)).toEqual(["accept-edits", "auto", "default"]);
    expect(configCalls(dir).at(-1)?.params).toMatchObject({ configId: "mode", value: "default" });
    expect(JSON.stringify(configCalls(dir))).not.toMatch(/yolo|auto_edit/);
    expect(json(join(dir, "dump.json")).argv).not.toContain("--dangerously-skip-permissions");
  });

  it("uses session/set_mode when agy lists its modes outside the config options", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_SESSION_MODES: "default,accept-edits,plan" });
    const setModes = () => configCalls(dir).filter((call) => call.method === "session/set_mode").map((call) => call.params.modeId);
    await run(instance, { text: "go", cwd: dir, approvalMode: "full" });
    expect(setModes()).toEqual(["default"]);
    await run(instance, { text: "go", cwd: dir, approvalMode: "edits", resumeCursor: "fake-acp-session" });
    expect(setModes().at(-1)).toBe("accept-edits");
  });

  it("sends Full access permission requests to later.dog instead of a skip-permissions flag", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_MODES: "default,accept-edits,auto", FAKE_ACP_MODE: "permission" });
    const recorder = recordEvents(instance.adapter);
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-full", text: "go", cwd: dir, approvalMode: "full" });
      const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId, 20_000);
      expect(opened).toMatchObject({ requestType: "permission" });
      expect(await instance.adapter.respondToRequest("t-full", opened.requestId!, { behavior: "allow" })).toBe("allowed-once");
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId, 20_000);
    } finally {
      recorder.stop();
    }
    expect(json(join(dir, "dump.json")).argv).toEqual(["acp", ...antigravityHome({ HOME: dir }).args]);
  });

  it("lists agy's models and effort levels unfiltered, sends no model until one is picked and remembers the last list", async () => {
    const dir = scratch();
    const levels = [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }];
    const environment = {
      FAKE_ACP_MODELS: "gemini-4-neon,gemini-4-hydrogen",
      FAKE_ACP_VARIANTS: JSON.stringify({ "gemini-4-hydrogen": { id: "thinking_level", currentValue: "high", options: levels } }),
    };
    const first = await antigravity(dir, environment, "agy-models");
    expect(first.models).toEqual(ANTIGRAVITY_FALLBACK_MODELS);
    expect(await run(first, { text: "hi", cwd: dir, model: "default" })).toMatchObject({ ok: true });
    expect(configCalls(dir)).toEqual([]);
    expect(first.models).toEqual({ default: "default", options: [
      { id: "default", label: "Default" },
      { id: "gemini-4-neon", label: "gemini-4-neon" },
      { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen" },
    ] });
    expect(await run(first, { threadId: "t-pick", text: "think", cwd: dir, model: "gemini-4-hydrogen", variant: "max" })).toMatchObject({ ok: true });
    expect(configCalls(dir).map((call) => [call.params.configId, call.params.value])).toEqual([["model", "gemini-4-hydrogen"], ["thinking_level", "max"]]);
    const hydrogen = first.models.options.find((option) => option.id === "gemini-4-hydrogen");
    expect(hydrogen?.variants).toEqual([{ id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" }]);
    const again = await antigravity(dir, environment, "agy-models");
    expect(again.models).toEqual(first.models);
  });

  it("finds effort by its category, keeps every model and returns nothing without a model option", () => {
    const sessionConfig = { configOptions: [
      { id: "model", type: "select", currentValue: "b", options: [{ group: "g", name: "Group", options: [{ value: "a", name: "Model A" }] }, { value: "b", name: "Model B" }] },
      { id: "effort", category: "other", type: "select", options: [{ value: "x", name: "X" }] },
      { id: "level", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    ] };
    expect(antigravityCatalog(sessionConfig)).toEqual({ default: "default", options: [
      { id: "default", label: "Default" },
      { id: "a", label: "Model A" },
      { id: "b", label: "Model B", variants: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] },
    ] });
    expect(antigravityCatalog({ configOptions: [{ id: "mode", type: "select", options: [] }] })).toBeNull();
  });

  it("reports signed in from agy's session list and signs out with agy's logout", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_SIGNED_OUT: "1" });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
    writeFileSync(join(dir, "signed-in"), "yes\n");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
    expect(json(join(dir, "rpc.json"))).toEqual(["initialize", "session/list"]);
    await instance.signOut!();
    expect(json(join(dir, "rpc.json"))).toContain("logout");
    expect(existsSync(join(dir, "signed-in"))).toBe(false);
    expect(await instance.snapshot()).toMatchObject({ authenticated: false });
  });

  it("asks for sign-in instead of failing a turn when agy is signed out", async () => {
    const dir = scratch();
    const instance = await antigravity(dir, { FAKE_ACP_SIGNED_OUT: "1" });
    expect(await run(instance, { text: "hi", cwd: dir })).toMatchObject({ ok: false });
    expect(json(join(dir, "rpc.json"))).not.toContain("authenticate");
  });
});
