import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  FIXTURE_STARTER_BOT_NAME,
  launchVerificationServer,
  runControlLaterDog,
} from "../scripts/control-laterdog.ts";

it("pins the fixture starter bot's name deterministically (#1257)", async () => {
  for (let launch = 0; launch < 2; launch++) {
    const fixture = await launchVerificationServer({});
    try {
      const response = await fetch(fixture.info.url + "/api/bots", {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      const bots = ((await response.json()) as { bots: Array<{ name: string }> }).bots;
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe(FIXTURE_STARTER_BOT_NAME);
    } finally {
      await fixture.close();
    }
  }
});

function machineInstalledCli(): string | undefined {
  const nodeDir = dirname(process.execPath);
  const dirs =
    process.platform === "win32"
      ? ["/opt/homebrew/bin", "/usr/local/bin"]
      : [nodeDir, "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (!existsSync(dir) || (process.platform === "win32" && dir === nodeDir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!/^[\w.-]+$/.test(name) || /^node(\.exe)?$/.test(name)) continue;
      try {
        const stat = statSync(join(dir, name));
        if (stat.isFile() && stat.mode & 0o111) return name;
      } catch {}
    }
  }
  return undefined;
}

it("keeps the fixture blind to this machine's installed CLIs (#2035)", async () => {
  const cli = machineInstalledCli();
  const fixture = await launchVerificationServer({});
  try {
    const get = async (path: string) => {
      const response = await fetch(fixture.info.url + path, {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      return response.json() as Promise<Record<string, any>>;
    };
    const { instances } = (await get("/api/instances")) as {
      instances: Array<{ instanceId: string; snapshot: { state: string } }>;
    };
    expect(instances.find((instance) => instance.instanceId === "chatgpt")?.snapshot.state).toBe(
      "unavailable",
    );
    expect(
      instances
        .filter((instance) => instance.snapshot.state === "available")
        .map((instance) => instance.instanceId),
    ).toEqual(["claude"]);
    if (cli) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
        expect(
          (await get(`/api/cli-candidates?name=${encodeURIComponent(cli)}`)).candidates,
        ).toEqual([]);
      }
    }
  } finally {
    await fixture.close();
  }
});

it("keeps low-memory eviction enabled despite memory flags in public message data", async () => {
  const fixture = await launchVerificationServer({ LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: "0" });
  try {
    const response = await fetch(fixture.info.url + "/api/bots", {
      headers: { origin: fixture.info.url },
    });
    expect(response.ok).toBe(true);
    const { bots } = (await response.json()) as { bots: Array<{ id: string; threadId: string }> };
    const bot = bots[0];
    const path = join(fixture.info.dataDir, "native", `${bot.threadId}.ndjson`);
    const closes = () =>
      existsSync(path)
        ? readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter(
              (entry) => entry.source === "claude.session" && entry.msg.close === "low memory",
            )
        : [];
    const before = closes().length;
    for (let turn = 1; turn <= 2; turn++) {
      const sent = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, {
        method: "POST",
        headers: { origin: fixture.info.url, "content-type": "application/json" },
        body: JSON.stringify({
          text: `Memory fixture turn ${turn}`,
          threadId: bot.threadId,
          LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: String(4 * 1024 ** 3),
          LATERDOG_TEST_SEALED_PATH: "1",
          env: {
            LATERDOG_TEST_AVAILABLE_MEMORY_BYTES: String(4 * 1024 ** 3),
            LATERDOG_TEST_SEALED_PATH: "1",
          },
        }),
      });
      expect(sent.ok).toBe(true);
      const settled = (await runControlLaterDog(
        ["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "10"],
        { env: { LATERDOG_URL: fixture.info.url } },
      )) as { status: string };
      expect(settled.status).toBe("settled");
      await expect.poll(() => closes().length).toBe(before + turn);
    }
  } finally {
    await fixture.close();
  }
});
