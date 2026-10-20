import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL,
  chunks,
  inside,
  isCandidate,
  listFiles,
  parseVerdict,
  restore,
  summary,
  sweep,
  workersAi,
} from "../skills/laterdog/quarantine-agent-bait/scripts/bait.mjs";

const WEAPONS = "BAIT-FIXTURE-WEAPONS";
const CRIME = "BAIT-FIXTURE-CRIME";
const UNJUDGED = "BAIT-FIXTURE-UNJUDGED";

const fakeGuard = async (text) => {
  if (text.includes(UNJUDGED)) throw new Error("Workers AI answered 503");
  const categories = [text.includes(CRIME) ? "S2" : null, text.includes(WEAPONS) ? "S9" : null].filter(Boolean);
  return { safe: categories.length === 0, categories };
};

const made = [];

function repository(files) {
  const parent = mkdtempSync(join(tmpdir(), "agent-bait-"));
  made.push(parent);
  const root = join(parent, "repo");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const listing = (files) => () => Object.keys(files);

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which files a sweep reads", () => {
  it("takes prose and agent instruction files and leaves code and dependencies alone", () => {
    expect(isCandidate("docs/notes.md")).toBe(true);
    expect(isCandidate("deep/a/b/README.markdown")).toBe(true);
    expect(isCandidate(".cursor/rules/style.mdc")).toBe(true);
    expect(isCandidate("AGENTS.md")).toBe(true);
    expect(isCandidate(".cursorrules")).toBe(true);
    expect(isCandidate("notes.txt")).toBe(true);
    expect(isCandidate("src/index.ts")).toBe(false);
    expect(isCandidate("node_modules/pkg/README.md")).toBe(false);
    expect(isCandidate(".git/COMMIT_EDITMSG")).toBe(false);
  });

  it("lists tracked and untracked files and respects .gitignore in a git repository", () => {
    const root = repository({ "a.md": "a", ".gitignore": "ignored.md\n", "ignored.md": "x", "sub/b.txt": "b" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(listFiles(root).sort()).toEqual([".gitignore", "a.md", "sub/b.txt"]);
  });

  it("walks the folder when it is not a git repository", () => {
    const root = repository({ "a.md": "a", "sub/b.md": "b" });
    expect(listFiles(root).sort()).toEqual(["a.md", "sub/b.md"]);
  });
});

describe("reading Llama Guard's answer", () => {
  it("reads the object form and the raw text form", () => {
    expect(parseVerdict({ response: { safe: false, categories: ["S9"] } })).toEqual({ safe: false, categories: ["S9"] });
    expect(parseVerdict({ response: "safe" })).toEqual({ safe: true, categories: [] });
    expect(parseVerdict({ response: "\nunsafe\nS1,S9" })).toEqual({ safe: false, categories: ["S1", "S9"] });
    expect(parseVerdict("unsafe\nS2")).toEqual({ safe: false, categories: ["S2"] });
  });

  it("refuses an answer it cannot read instead of calling it safe", () => {
    expect(() => parseVerdict({ response: "maybe" })).toThrow(/does not read/);
    expect(() => parseVerdict({ response: 42 })).toThrow(/does not read/);
  });

  it("splits long files so every part is judged", () => {
    expect(chunks("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(chunks("")).toEqual([""]);
  });
});

describe("calling Workers AI", () => {
  it("runs Llama Guard on Workers AI and asks an AI Gateway not to log the text", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ result: { response: "unsafe\nS9" }, success: true }) };
    };
    const direct = workersAi({ accountId: "acc", token: "tok", fetchImpl });
    expect(await direct("text")).toEqual({ safe: false, categories: ["S9"] });
    const gated = workersAi({ accountId: "acc", token: "tok", gateway: "gw", fetchImpl });
    await gated("text");
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${MODEL}`);
    expect(calls[1].url).toBe(`https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/${MODEL}`);
    expect(calls[1].init.headers).toMatchObject({ authorization: "Bearer tok", "cf-aig-collect-log": "false" });
    expect(JSON.parse(calls[1].init.body)).toMatchObject({ messages: [{ role: "user", content: "text" }], temperature: 0 });
  });

  it("needs an account and a token, and treats an error status as a failure", async () => {
    expect(() => workersAi({ accountId: "", token: "tok" })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    const failing = workersAi({ accountId: "acc", token: "tok", fetchImpl: async () => ({ ok: false, status: 403 }) });
    await expect(failing("text")).rejects.toThrow(/403/);
  });
});

describe("a sweep", () => {
  const files = {
    "README.md": "How to build the project.",
    "docs/notes/planted.md": `intro\n${WEAPONS}\noutro`,
    "src/lib/also-planted.md": `${CRIME} and ${WEAPONS}`,
    "src/index.ts": WEAPONS,
    "docs/broken.md": UNJUDGED,
  };

  it("reports flagged files by path, hash and category and never carries their text", async () => {
    const root = repository(files);
    const report = await sweep({ root, ask: fakeGuard, list: listing(files), now: new Date("2026-10-20T21:00:00Z") });
    expect(report.checked).toBe(4);
    expect(report.flagged.map((file) => [file.path, file.categories])).toEqual([
      ["docs/notes/planted.md", ["S9"]],
      ["src/lib/also-planted.md", ["S2", "S9"]],
    ]);
    expect(report.flagged[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.unread).toEqual([{ path: "docs/broken.md", reason: "Workers AI answered 503" }]);
    expect(JSON.stringify(report)).not.toContain(WEAPONS);
    expect(summary(report)).not.toContain(WEAPONS);
    expect(summary(report)).toContain("S9 Indiscriminate Weapons");
    expect(existsSync(join(root, "docs/notes/planted.md"))).toBe(true);
  });

  it("judges every part of a long file", async () => {
    const tail = { "long.md": `${"a".repeat(20_000)}${WEAPONS}` };
    const root = repository(tail);
    const report = await sweep({ root, ask: fakeGuard, list: listing(tail) });
    expect(report.flagged.map((file) => file.path)).toEqual(["long.md"]);
  });

  it("moves flagged files out of the working tree with a manifest and puts them back", async () => {
    const root = repository(files);
    const report = await sweep({ root, ask: fakeGuard, list: listing(files), quarantine: true, now: new Date("2026-10-20T21:00:00Z") });
    expect(existsSync(join(root, "docs/notes/planted.md"))).toBe(false);
    expect(existsSync(join(root, "docs/broken.md"))).toBe(true);
    expect(report.quarantine.dir.startsWith(`${root}.quarantine`)).toBe(true);
    const manifest = readFileSync(report.quarantine.manifest, "utf8");
    expect(JSON.parse(manifest).files.map((file) => file.path)).toEqual(["docs/notes/planted.md", "src/lib/also-planted.md"]);
    expect(manifest).not.toContain(WEAPONS);
    expect(await restore(report.quarantine.manifest)).toEqual(["docs/notes/planted.md", "src/lib/also-planted.md"]);
    expect(readFileSync(join(root, "docs/notes/planted.md"), "utf8")).toBe(files["docs/notes/planted.md"]);
  });

  it("names the commit and author that added a flagged file", async () => {
    const planted = { "notes/planted.md": WEAPONS };
    const root = repository(planted);
    const env = { ...process.env, GIT_AUTHOR_NAME: "Mallory", GIT_AUTHOR_EMAIL: "m@example.com", GIT_COMMITTER_NAME: "Mallory", GIT_COMMITTER_EMAIL: "m@example.com" };
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "docs"], { cwd: root, env });
    const report = await sweep({ root, ask: fakeGuard });
    expect(report.flagged[0].added).toMatchObject({ author: "Mallory" });
    expect(report.flagged[0].added.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("restoring", () => {
  it("refuses paths that leave the repository", () => {
    expect(() => inside("/repo", "../outside.md")).toThrow(/outside/);
    expect(() => inside("/repo", "/etc/passwd")).toThrow(/outside/);
    expect(inside("/repo", "..notes.md")).toBe("/repo/..notes.md");
  });

  it("restores nothing when a quarantined file changed or a file came back", async () => {
    const planted = { "a.md": WEAPONS, "b.md": WEAPONS };
    const root = repository(planted);
    const first = await sweep({ root, ask: fakeGuard, list: listing(planted), quarantine: true, now: new Date("2026-10-20T21:00:00Z") });
    writeFileSync(join(first.quarantine.dir, "files", "b.md"), "edited");
    await expect(restore(first.quarantine.manifest)).rejects.toThrow(/changed in quarantine/);
    expect(existsSync(join(root, "a.md"))).toBe(false);
    writeFileSync(join(first.quarantine.dir, "files", "b.md"), WEAPONS);
    writeFileSync(join(root, "a.md"), "new");
    await expect(restore(first.quarantine.manifest)).rejects.toThrow(/exists in the repository again/);
  });
});
