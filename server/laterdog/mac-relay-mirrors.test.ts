import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_RELAY_INSTANCE_ID } from "./mac-relay.ts";
import { createMacRelayMirrors, MAC_RELAY_MIRRORS_FILE, type MirrorBot, type MirrorProfile } from "./mac-relay-mirrors.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-mac-relay-mirrors-"));
  dirs.push(dir);
  const bots = new Map<string, MirrorBot & { profile: MirrorProfile }>();
  bots.set("plain", { id: "plain", modelSelection: { instanceId: "claude" }, profile: { name: "Plain" } });
  let next = 0;
  const file = join(dir, MAC_RELAY_MIRRORS_FILE);
  const mirrors = createMacRelayMirrors({
    file,
    bot: (id) => bots.get(id),
    create: (profile) => {
      const bot = { id: `home-${++next}`, modelSelection: { instanceId: MAC_RELAY_INSTANCE_ID }, profile };
      bots.set(bot.id, bot);
      return bot;
    },
    update: (id, profile) => { bots.get(id)!.profile = profile; },
  });
  return { file, bots, mirrors };
}

describe("mirrored Mac dogs on a Cloud home", () => {
  it("makes one relayed dog per local dog and keeps it in step with the Mac", () => {
    const { file, bots, mirrors } = fixture();
    expect(mirrors.ensure("local-a", { name: "Rex" })).toEqual({ botId: "home-1", created: true });
    expect(mirrors.ensure("local-a", { name: "Rex", title: "Fixer" })).toEqual({ botId: "home-1", created: false });
    expect(bots.get("home-1")!.profile).toEqual({ name: "Rex", title: "Fixer" });
    expect(mirrors.ensure("local-b", { name: "Ada" })).toEqual({ botId: "home-2", created: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "local-a": "home-1", "local-b": "home-2" });
  });

  it("tells relayed dogs from ordinary ones", () => {
    const { mirrors } = fixture();
    mirrors.ensure("local-a", { name: "Rex" });
    expect(mirrors.isRelayBot("home-1")).toBe(true);
    expect(mirrors.isRelayBot("plain")).toBe(false);
    expect(mirrors.isRelayBot("missing")).toBe(false);
  });

  it("makes a fresh mirror when the old one was deleted on the home", () => {
    const { bots, mirrors } = fixture();
    mirrors.ensure("local-a", { name: "Rex" });
    bots.delete("home-1");
    expect(mirrors.ensure("local-a", { name: "Rex" })).toEqual({ botId: "home-2", created: true });
  });
});
