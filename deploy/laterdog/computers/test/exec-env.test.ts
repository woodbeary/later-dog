import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { ENV_MAX_ENTRIES, ENV_VALUE_MAX_BYTES, RESERVED_ENV_NAMES, commandEnv, parseCreate, parseEnv, parseExec, redact } from "../src/inputs";
import { OWNER_KEY, type World, apiRequest, body, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SECRET = "sk-ant-test-value-that-must-stay-hidden";
const BASE = {
  HOME: "/home/dog",
  USER: "dog",
  LOGNAME: "dog",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  TZ: "UTC",
  DISPLAY: ":0",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  NO_AT_BRIDGE: "1",
};

describe("parseEnv", () => {
  it("accepts upper-case names with string values", () => {
    expect(parseEnv({ ANTHROPIC_API_KEY: SECRET, _X1: "", LANG: "en_US.UTF-8" })).toEqual({
      ok: true,
      value: { ANTHROPIC_API_KEY: SECRET, _X1: "", LANG: "en_US.UTF-8" },
    });
  });

  it("refuses names that do not match the pattern", () => {
    for (const name of ["lower", "1ABC", "A-B", "A B", "", "Ä", "__proto__", "A=B"]) {
      expect(parseEnv({ [name]: "x" }), name).toMatchObject({ ok: false, refusal: { status: 400, code: "invalid_env" } });
    }
  });

  it("refuses every reserved name", () => {
    expect(RESERVED_ENV_NAMES).toEqual(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]);
    for (const name of RESERVED_ENV_NAMES) {
      expect(parseEnv({ [name]: "/tmp" }), name).toMatchObject({ ok: false, refusal: { status: 400, code: "invalid_env" } });
    }
  });

  it("refuses more than 32 entries", () => {
    const entries = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`V${i}`, "x"]));
    expect(ENV_MAX_ENTRIES).toBe(32);
    expect(parseEnv(entries(32))).toMatchObject({ ok: true });
    expect(parseEnv(entries(33))).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
  });

  it("refuses values over 16 KiB of UTF-8, with NUL, or not strings", () => {
    expect(ENV_VALUE_MAX_BYTES).toBe(16 * 1024);
    expect(parseEnv({ A: "a".repeat(16 * 1024) })).toMatchObject({ ok: true });
    expect(parseEnv({ A: "a".repeat(16 * 1024 + 1) })).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
    expect(parseEnv({ A: "é".repeat(8 * 1024 + 1) })).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
    expect(parseEnv({ A: "a\u0000b" })).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
    for (const value of [1, true, null, { v: "x" }, ["x"]]) {
      expect(parseEnv({ A: value }), JSON.stringify(value)).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
    }
  });

  it("refuses an env that is not an object", () => {
    for (const raw of ["A=B", ["A=B"], 5]) expect(parseEnv(raw)).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
  });

  it("never puts a value in its error messages", () => {
    const refusals = [
      parseEnv({ lower: SECRET }),
      parseEnv({ HOME: SECRET }),
      parseEnv({ PATH: SECRET }),
      parseEnv({ A: `${SECRET}\u0000` }),
      parseEnv({ A: SECRET.repeat(1000) }),
      parseEnv({ [SECRET.toUpperCase().replaceAll("-", "_")]: 1 }),
      parseExec({ command: "true", env: { A: SECRET, b: SECRET } }),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      expect(JSON.stringify(refusal)).not.toContain(SECRET);
      expect(JSON.stringify(refusal)).not.toContain(SECRET.toUpperCase().replaceAll("-", "_"));
    }
  });
});

describe("parseExec with env", () => {
  it("keeps env when given and leaves it out when absent or empty", () => {
    expect(parseExec({ command: "claude -p hi", env: { ANTHROPIC_API_KEY: SECRET } })).toEqual({
      ok: true,
      value: { command: "claude -p hi", timeoutMs: 120_000, env: { ANTHROPIC_API_KEY: SECRET } },
    });
    expect(parseExec({ command: "ls", env: null })).toEqual({ ok: true, value: { command: "ls", timeoutMs: 120_000 } });
    expect(parseExec({ command: "ls", env: {} })).toEqual({ ok: true, value: { command: "ls", timeoutMs: 120_000 } });
    expect(parseExec({ command: "ls", env: { HOME: "/root" } })).toMatchObject({ ok: false, refusal: { code: "invalid_env" } });
  });
});

describe("commandEnv", () => {
  it("merges the entries over the base without changing the base", () => {
    const base = { ...BASE };
    expect(commandEnv(base, { LANG: "en_US.UTF-8", TOKEN: "t" })).toEqual({ ...BASE, LANG: "en_US.UTF-8", TOKEN: "t" });
    expect(base).toEqual(BASE);
    expect(commandEnv(base)).toEqual(BASE);
    expect(commandEnv(base)).not.toBe(base);
  });
});

describe("redact", () => {
  it("removes each value, raw or JSON-escaped, from a message", () => {
    expect(redact(`spawn failed: TOKEN=${SECRET} rejected`, [SECRET])).toBe("spawn failed: TOKEN=[redacted] rejected");
    expect(redact('bad env {"A":"line\\none"}', ["line\none"])).toBe('bad env {"A":"[redacted]"}');
    expect(redact("nothing here", ["", SECRET])).toBe("nothing here");
  });
});

describe("the xlarge size", () => {
  it("is accepted", () => {
    expect(parseCreate({ size: "xlarge" })).toEqual({ ok: true, value: { size: "xlarge" } });
  });
});

async function runningComputer(w: World, size?: string): Promise<string> {
  const created = await w.fetch(apiRequest("POST", "/v1/computers", OWNER_KEY, { body: size === undefined ? {} : { size } }));
  expect(created.status).toBe(201);
  const { computer } = await body(created);
  await w.advance(MINUTE);
  const current = await body(await w.fetch(apiRequest("GET", `/v1/computers/${computer.id}`, OWNER_KEY)));
  expect(current.computer.state).toBe("running");
  return computer.id;
}

function commands(w: World, id: string) {
  return w.containers.get(id)!.execs.filter((call) => call.cmd.includes("-lc"));
}

function storedRecord(w: World, id: string): unknown {
  const instance = w.computers.instances.get(id) as unknown as { ctx: DurableObjectState };
  return instance.ctx.storage.kv.get("computer");
}

function everythingLogged(w: World): string {
  return JSON.stringify([...w.logs.mock.calls, ...w.errors.mock.calls]);
}

describe("exec with env, through the Worker", () => {
  it("starts an xlarge computer on standard-4", async () => {
    const w = await world();
    const id = await runningComputer(w, "xlarge");
    expect(w.containers.get(id)!.starts).toMatchObject([{ instance: "standard-4" }]);
    const listed = await body(await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY)));
    expect(listed.computers).toMatchObject([{ id, size: "xlarge" }]);
  });

  it("merges env over the base for that one command only", async () => {
    const w = await world();
    const id = await runningComputer(w);
    const withEnv = await w.fetch(
      apiRequest("POST", `/v1/computers/${id}/exec`, OWNER_KEY, {
        body: { command: "setsid -f bash run.sh", env: { ANTHROPIC_API_KEY: SECRET, LANG: "en_US.UTF-8" } },
      }),
    );
    expect(withEnv.status).toBe(200);
    expect(await body(withEnv)).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const without = await w.fetch(apiRequest("POST", `/v1/computers/${id}/exec`, OWNER_KEY, { body: { command: "env" } }));
    expect(without.status).toBe(200);

    const [first, second] = commands(w, id);
    expect(first!.cmd.slice(-3)).toEqual(["bash", "-lc", "setsid -f bash run.sh"]);
    expect(first!.options).toMatchObject({ user: "1000:1000", cwd: "/home/dog" });
    expect(first!.options!.env).toEqual({ ...BASE, LANG: "en_US.UTF-8", ANTHROPIC_API_KEY: SECRET });
    expect(second!.options!.env).toEqual(BASE);

    const ready = w.containers.get(id)!.execs.filter((call) => !call.cmd.includes("-lc"));
    expect(ready.length).toBeGreaterThan(0);
    for (const call of ready) expect(call.options!.env).toEqual(BASE);
  });

  it("keeps values out of the record, the listing and the logs", async () => {
    const w = await world();
    const id = await runningComputer(w);
    const response = await w.fetch(apiRequest("POST", `/v1/computers/${id}/exec`, OWNER_KEY, { body: { command: "true", env: { TOKEN: SECRET } } }));
    expect(response.status).toBe(200);
    await w.advance(20 * MINUTE);
    expect(JSON.stringify(storedRecord(w, id))).not.toContain(SECRET);
    expect(JSON.stringify(storedRecord(w, id))).not.toContain("TOKEN");
    const listed = await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY));
    expect(await listed.text()).not.toContain(SECRET);
    const described = await w.fetch(apiRequest("GET", `/v1/computers/${id}`, OWNER_KEY));
    expect(await described.text()).not.toContain(SECRET);
    expect(everythingLogged(w)).not.toContain(SECRET);
  });

  it("refuses a bad env with 400 invalid_env, without running anything or echoing the value", async () => {
    const w = await world();
    const id = await runningComputer(w);
    for (const env of [{ HOME: SECRET }, { PATH: SECRET }, { lower: SECRET }, { A: SECRET.repeat(500) }, { A: 7 }, "TOKEN=x"]) {
      const response = await w.fetch(apiRequest("POST", `/v1/computers/${id}/exec`, OWNER_KEY, { body: { command: "true", env } }));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text).error.code).toBe("invalid_env");
      expect(text).not.toContain(SECRET);
    }
    expect(commands(w, id)).toEqual([]);
    expect(everythingLogged(w)).not.toContain(SECRET);
  });

  it("redacts values from a failed command's error body and log line", async () => {
    const w = await world();
    const id = await runningComputer(w);
    w.containers.get(id)!.failCommands = new Error(`exec rejected env TOKEN=${SECRET} and OTHER="${SECRET}"`);
    const response = await w.fetch(apiRequest("POST", `/v1/computers/${id}/exec`, OWNER_KEY, { body: { command: "true", env: { TOKEN: SECRET } } }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error).toEqual({ code: "container_error", message: 'exec rejected env TOKEN=[redacted] and OTHER="[redacted]"' });
    expect(text).not.toContain(SECRET);
    expect(everythingLogged(w)).not.toContain(SECRET);
    expect(everythingLogged(w)).toContain("[redacted]");
  });
});
