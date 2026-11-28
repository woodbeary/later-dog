import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { carryCodexSession } from "./codex-session-carry.ts";

const CURSOR = "01a21e1b-b177-7771-94a7-730e42da25dc";
const NAME = `2026/11/27/rollout-2026-11-27T09-44-21-${CURSOR}.jsonl`;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const homes = () => {
  const root = mkdtempSync(join(tmpdir(), "laterdog-codex-carry-"));
  dirs.push(root);
  const from = join(root, "a"), to = join(root, "b");
  mkdirSync(join(from, "sessions", "2026", "11", "27"), { recursive: true });
  mkdirSync(to, { recursive: true });
  writeFileSync(join(from, "sessions", NAME), `{"type":"session_meta","payload":{"id":"${CURSOR}"}}\n`);
  return { from, to };
};

describe("carrying a Codex session to another account", () => {
  it("copies the chat's rollout into the next account's sessions under the same name, so the same thread resumes there", async () => {
    const { from, to } = homes();
    expect(await carryCodexSession({ cursor: CURSOR, fromHome: from, toHome: to })).toEqual({ sessionId: CURSOR, copied: [join("sessions", NAME)] });
    expect(readFileSync(join(to, "sessions", NAME), "utf8")).toContain(CURSOR);
  });

  it("carries nothing for a missing, invalid or same-account session", async () => {
    const { from, to } = homes();
    expect(await carryCodexSession({ cursor: "01a21e1b-b177-7771-94a7-000000000000", fromHome: from, toHome: to })).toBeUndefined();
    expect(await carryCodexSession({ cursor: "../x", fromHome: from, toHome: to })).toBeUndefined();
    expect(await carryCodexSession({ cursor: CURSOR, fromHome: from, toHome: from })).toBeUndefined();
    expect(await carryCodexSession({ cursor: CURSOR, fromHome: join(from, "none"), toHome: to })).toBeUndefined();
  });

  it("never writes through a link planted at the target", async () => {
    const { from, to } = homes();
    mkdirSync(join(to, "sessions", "2026", "11", "27"), { recursive: true });
    symlinkSync(join(from, "elsewhere"), join(to, "sessions", NAME));
    expect(await carryCodexSession({ cursor: CURSOR, fromHome: from, toHome: to })).toBeUndefined();
  });
});
