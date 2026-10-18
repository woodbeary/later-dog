import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import type { WireBot } from "../shared/wire.ts";

it("keeps saved About me text and learned facts out of preview, direct and group turns", async () => {
  const fixture = await launchVerificationServer();
  const control = (...args: string[]) => runControlLaterDog([...args, "--url", fixture.info.url]);
  const api = async <T = { profile: Record<string, string> }>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(status);
    return response.json() as Promise<T>;
  };
  const sentSystem = () => (JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { systemPrompt: string }).systemPrompt;
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Profile fixture" }, 201);
    await api("/api/config", "PUT", { profile: { name: "Fixture user", email: "fixture@example.invalid" } });
    const aboutMe = "I prefer concise answers.\n- 2026-10-01 · learned by Profile fixture · My work week begins on Tuesday.";
    const saved = await api("/api/config", "PUT", { profile: { aboutMe } });
    expect(saved.profile).toEqual({ name: "Fixture user", email: "fixture@example.invalid" });
    expect((await api("/api/config")).profile).not.toHaveProperty("aboutMe");
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).profile.aboutMe).toBe(aboutMe);

    const preview = JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`));
    expect(preview).not.toContain("concise answers");
    expect(preview).not.toContain("learned by");
    expect(preview).not.toContain("About the user");
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Hello.");
    expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).not.toContain("concise answers");
    expect(sentSystem()).not.toContain("learned by");

    const created = await control("new-channel", "--name", "Profile room", "--members", bot.id) as { channel: { id: string } };
    await control("send-channel", "--channel", created.channel.id, "--text", "Hello team.");
    expect(await control("wait", "--channel", created.channel.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSystem()).not.toContain("concise answers");
    expect(sentSystem()).not.toContain("learned by");

    await api("/api/config", "PUT", { profile: { name: "Renamed fixture" } });
    expect((await api("/api/config")).profile).toEqual({ name: "Renamed fixture", email: "fixture@example.invalid" });
  } finally {
    await fixture.close();
  }
}, 90_000);
