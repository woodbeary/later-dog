import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForExit } from "../testing/cleanup.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROXY_SOURCE = join(HERE, "agents-proxy.ts");
const GOLDENS = join(HERE, "agents-catalog-goldens");
const UPDATE = process.env.UPDATE_AGENTS_CATALOG_GOLDENS === "1";

interface Profile {
  family: "direct";
  env: Record<string, string>;
}

const flag = (on: boolean) => (on ? "1" : "0");

function profiles(): Record<string, Profile> {
  const all: Record<string, Profile> = {};
  for (const skills of [false, true]) {
    for (const shared of [false, true]) {
      for (const voice of [false, true]) {
        const name = ["direct", skills && "skills", shared && "shared", voice && "voice"].filter(Boolean).join("+");
        all[name] = {
          family: "direct",
          env: {
            LATERDOG_SKILL_AUTHORING_ENABLED: flag(skills),
            LATERDOG_SHARED_COMPUTERS_ENABLED: flag(shared),
            LATERDOG_VOICE_NOTES: flag(voice),
          },
        };
      }
    }
  }
  all["direct+skills+shared+voice+cloud-home"] = { family: "direct", env: { ...all["direct+skills+shared+voice"]!.env, LATERDOG_CLOUD_HOME: "1" } };
  all["direct+skills+shared+voice+cloud-home+phone"] = { family: "direct", env: { ...all["direct+skills+shared+voice+cloud-home"]!.env, LATERDOG_PHONE: "1" } };
  return all;
}

const PROFILES = profiles();
const REMOVED_TEAM_TOOLS = ["list_team_setup", "propose_team_setup", "propose_bot_deletion", "retry_thread"];
const REMOVED_PEER_TOOLS = ["ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "send_to_bot", "list_room_targets"];
const FULL = { direct: "direct+skills+shared+voice" } as const;
const PHONE_TOOLS = ["read_phone", "add_to_phone", "change_on_phone"];
const MAC_MESSAGE_TOOLS = ["send_text", "read_texts", "send_email"];

const BUDGET_BASELINE: Record<string, number> = {
  "direct": 33979,
  "direct+voice": 34720,
  "direct+shared": 37737,
  "direct+shared+voice": 38478,
  "direct+skills": 36032,
  "direct+skills+voice": 36773,
  "direct+skills+shared": 39790,
  "direct+skills+shared+voice": 40531,
  "direct+skills+shared+voice+cloud-home": 42718,
  "direct+skills+shared+voice+cloud-home+phone": 45602,
};

const RPC_PREFIX = '{"jsonrpc":"2.0","id":1,"result":';

async function toolsListWire(entry: string, env: Record<string, string>): Promise<string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LATERDOG_")));
  const child = spawn(process.execPath, [entry], {
    env: { ...inherited, LATERDOG_HARNESS_URL: "http://127.0.0.1:9", LATERDOG_BOT_ID: "bot-golden", LATERDOG_THREAD_ID: "thread-golden", LATERDOG_COMMS_TOKEN: "unused", LATERDOG_TURN_DEPTH: "0", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(buffer.slice(0, newline));
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`agents proxy exited (${code}) before answering tools/list`)));
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    });
    expect(line.startsWith(RPC_PREFIX) && line.endsWith("}")).toBe(true);
    return line.slice(RPC_PREFIX.length, -1);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

async function wireForEveryProfile(entry: string): Promise<Record<string, string>> {
  const names = Object.keys(PROFILES);
  const wires = await Promise.all(names.map((name) => toolsListWire(entry, PROFILES[name]!.env)));
  return Object.fromEntries(names.map((name, index) => [name, wires[index]!]));
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
type Tool = { name: string };
const toolsOf = (wire: string) => (JSON.parse(wire) as { tools: Tool[] }).tools;

const goldenPath = (family: keyof typeof FULL) => join(GOLDENS, `${family}-full.tools-list.json`);
const manifestPath = join(GOLDENS, "profiles.json");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const manifestOf = (wires: Record<string, string>) =>
  Object.fromEntries(Object.entries(wires).map(([name, wire]) => [
    name,
    { bytes: bytes(wire), sha256: sha256(wire), tools: toolsOf(wire).map((tool) => tool.name) },
  ]));

let wires: Record<string, string> = {};

beforeAll(async () => {
  wires = await wireForEveryProfile(PROXY_SOURCE);
  if (UPDATE) {
    for (const family of Object.keys(FULL) as (keyof typeof FULL)[]) writeJson(goldenPath(family), JSON.parse(wires[FULL[family]]!));
    writeJson(manifestPath, manifestOf(wires));
  }
}, 120_000);

describe("agents proxy tools/list golden", () => {
  it("round-trips through JSON.parse unchanged, so a parsed golden can stand for the bytes", () => {
    for (const wire of Object.values(wires)) expect(JSON.stringify(JSON.parse(wire))).toBe(wire);
  });

  it.each(Object.keys(FULL) as (keyof typeof FULL)[])("%s: the fullest profile is byte-identical to its golden", (family) => {
    const golden = readJson(goldenPath(family));
    const wire = wires[FULL[family]]!;
    expect(JSON.parse(wire)).toEqual(golden);
    expect(wire).toBe(JSON.stringify(golden));
  });

  it("every profile matches its pinned tool names, byte count and sha256", () => {
    expect(manifestOf(wires)).toEqual(readJson(manifestPath));
  });

  it("every profile is a by-name subset of its family's full golden, tool bytes included", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const full = new Map(toolsOf(wires[FULL[profile.family]]!).map((tool) => [tool.name, JSON.stringify(tool)]));
      for (const tool of toolsOf(wires[name]!)) {
        if (profile.env.LATERDOG_CLOUD_HOME === "1" && tool.name === "select_computer") continue;
        if (profile.env.LATERDOG_PHONE === "1" && PHONE_TOOLS.includes(tool.name)) continue;
        if (profile.env.LATERDOG_CLOUD_HOME === "1" && MAC_MESSAGE_TOOLS.includes(tool.name)) continue;
        expect(JSON.stringify(tool), `${name}: ${tool.name}`).toBe(full.get(tool.name));
      }
    }
  });

  it("gives a Cloud home's dogs the person's iPhone as three tools, and only reading goes unasked", () => {
    type Annotated = Tool & { annotations?: { readOnlyHint?: boolean } };
    const cloud = toolsOf(wires["direct+skills+shared+voice+cloud-home"]!) as Annotated[];
    const phone = toolsOf(wires["direct+skills+shared+voice+cloud-home+phone"]!) as Annotated[];
    expect(phone.map((tool) => tool.name).filter((name) => !cloud.some((tool) => tool.name === name))).toEqual(PHONE_TOOLS);
    for (const wire of Object.values(wires).filter((wire) => wire !== wires["direct+skills+shared+voice+cloud-home+phone"])) {
      expect(toolsOf(wire).map((tool) => tool.name).filter((name) => PHONE_TOOLS.includes(name))).toEqual([]);
    }
    expect(phone.find((tool) => tool.name === "read_phone")?.annotations?.readOnlyHint).toBe(true);
    expect(phone.find((tool) => tool.name === "add_to_phone")?.annotations).toBeUndefined();
    expect(phone.find((tool) => tool.name === "change_on_phone")?.annotations).toBeUndefined();
  });

  it("gives a Cloud home's dogs texts and email on the Mac as three tools, and only reading goes unasked", () => {
    type Annotated = Tool & { annotations?: { readOnlyHint?: boolean } };
    const cloud = toolsOf(wires["direct+skills+shared+voice+cloud-home"]!) as Annotated[];
    const desktop = toolsOf(wires["direct+skills+shared+voice"]!);
    expect(cloud.map((tool) => tool.name).filter((name) => !desktop.some((tool) => tool.name === name))).toEqual(MAC_MESSAGE_TOOLS);
    for (const [name, profile] of Object.entries(PROFILES)) {
      if (profile.env.LATERDOG_CLOUD_HOME === "1") continue;
      expect(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => MAC_MESSAGE_TOOLS.includes(tool)), name).toEqual([]);
    }
    expect(cloud.find((tool) => tool.name === "read_texts")?.annotations?.readOnlyHint).toBe(true);
    expect(cloud.find((tool) => tool.name === "send_text")?.annotations).toBeUndefined();
    expect(cloud.find((tool) => tool.name === "send_email")?.annotations).toBeUndefined();
  });

  it("shows a Cloud home's bots no this computer, and every other server both places", () => {
    type SelectTool = Tool & { inputSchema: { properties: { surface: { enum: string[]; description: string } } } };
    const select = (wire: string) => toolsOf(wire).find((tool) => tool.name === "select_computer") as SelectTool;
    const cloudHome = Object.keys(PROFILES).filter((name) => name.endsWith("+cloud-home"));
    expect(cloudHome).toHaveLength(1);
    for (const name of cloudHome) {
      const desktop = wires[name.slice(0, -"+cloud-home".length)]!;
      expect(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => !MAC_MESSAGE_TOOLS.includes(tool))).toEqual(toolsOf(desktop).map((tool) => tool.name));
      expect(select(desktop).inputSchema.properties.surface.enum).toEqual(["auto", "cloud", "local"]);
      const surface = select(wires[name]!).inputSchema.properties.surface;
      expect(surface.enum).toEqual(["auto", "cloud", "mac"]);
      expect(surface.description).not.toMatch(/\blocal =/);
    }
    for (const wire of Object.values(wires)) expect(toolsOf(wire).map((tool) => tool.name)).not.toContain("vm_exec");
  });

  it("gives no dog the retired team setup tools or a way to change another dog's profile, model or routines", () => {
    type SchemaTool = Tool & { inputSchema: { properties: Record<string, unknown> } };
    for (const [name, wire] of Object.entries(wires)) {
      const tools = toolsOf(wire) as SchemaTool[];
      expect(REMOVED_TEAM_TOOLS.filter((tool) => tools.some((candidate) => candidate.name === tool)), name).toEqual([]);
      for (const tool of tools) expect(tool.inputSchema.properties, `${name}: ${tool.name}`).not.toHaveProperty("for_bot_id");
    }
    expect(wires[FULL.direct]).not.toMatch(/Chief/);
  });

  it("gives every dog coordinate_bots as its one way to work with another dog", () => {
    for (const [name, wire] of Object.entries(wires)) {
      const tools = toolsOf(wire).map((tool) => tool.name);
      expect(tools, name).toContain("coordinate_bots");
      expect(tools, name).toContain("list_bots");
      expect(REMOVED_PEER_TOOLS.filter((tool) => tools.includes(tool)), name).toEqual([]);
    }
  });

  it("is what the catalog module computes in-process, so another front end mounts the same tools", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const tools = availableTools(catalogProfileFromEnv({ LATERDOG_BOT_ID: "bot-golden", ...profile.env }));
      expect(JSON.stringify({ tools }), name).toBe(wires[name]);
    }
  });

  it("writes the routine fields out identically in both routine tools", () => {
    type RoutineTool = Tool & { inputSchema: { properties: Record<string, unknown> & { changes: { properties: Record<string, unknown> } } } };
    const tools = new Map(toolsOf(wires[FULL.direct]!).map((tool) => [tool.name, tool as RoutineTool]));
    const created = tools.get("propose_routine")!.inputSchema.properties;
    const changed = tools.get("propose_routine_action")!.inputSchema.properties.changes.properties;
    expect(Object.keys(changed).length).toBeGreaterThan(0);
    for (const field of Object.keys(changed)) expect(JSON.stringify(created[field]), field).toBe(JSON.stringify(changed[field]));
    expect(Object.keys(created).slice(0, Object.keys(changed).length)).toEqual(Object.keys(changed));
  });

  it("uses no JSON-Schema keyword a provider conversion is known to drop or mangle", () => {
    for (const [name, wire] of Object.entries(wires)) {
      expect(wire.match(/"(\$ref|\$defs|definitions|oneOf|anyOf|allOf)":/g), name).toBeNull();
    }
  });
});

describe("agents proxy tools/list from the packaged bundle", () => {
  let directory = "";
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("serves the same bytes with no source tree beside it", async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-agents-proxy-bundle-")));
    await build({
      entryPoints: [PROXY_SOURCE],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outbase: join(HERE, ".."),
      outdir: directory,
      logLevel: "silent",
    });
    const bundled = join(directory, "drivers", "agents-proxy.js");
    expect(existsSync(bundled)).toBe(true);
    expect(readFileSync(bundled, "utf8")).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(await wireForEveryProfile(bundled)).toEqual(wires);
  }, 120_000);
});

describe("agents proxy tools/list wire size", () => {
  it("prints per-tool and total UTF-8 bytes", () => {
    const shown = Object.values(FULL);
    const perTool = new Map<string, Record<string, number>>();
    for (const name of shown) {
      for (const tool of toolsOf(wires[name]!)) {
        perTool.set(tool.name, { ...perTool.get(tool.name), [name]: bytes(JSON.stringify(tool)) });
      }
    }
    const largest = (sizes: Record<string, number>) => Math.max(...Object.values(sizes));
    const rows = [...perTool.entries()].sort((a, b) => largest(b[1]) - largest(a[1]));
    const lines = [
      "agents proxy tools/list, UTF-8 bytes of the serialized result",
      "",
      "total per profile:",
      ...Object.entries(wires).map(([name, wire]) => `  ${String(bytes(wire)).padStart(6)}  ${String(toolsOf(wire).length).padStart(2)} tools  ${name}`),
      "",
      `per tool (${shown.join(" | ")}); every other profile is a by-name subset with identical tool bytes:`,
      ...rows.map(([tool, sizes]) => `  ${shown.map((name) => String(sizes[name] ?? "-").padStart(6)).join(" ")}  ${tool}`),
    ];
    console.log(lines.join("\n"));
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PROFILES))("%s stays within 2% of its budget baseline", (name) => {
    const baseline = BUDGET_BASELINE[name];
    expect(baseline, `${name} has no BUDGET_BASELINE entry`).toBeTypeOf("number");
    const actual = bytes(wires[name]!);
    expect(actual, `${name} grew past its budget (${baseline} + 2%). Trim the catalog, or raise BUDGET_BASELINE on purpose.`)
      .toBeLessThanOrEqual(Math.floor(baseline! * 1.02));
    expect(actual, `${name} shrank by more than 2%. Lower BUDGET_BASELINE to ${actual} so the saving cannot creep back.`)
      .toBeGreaterThanOrEqual(Math.ceil(baseline! * 0.98));
  });
});
