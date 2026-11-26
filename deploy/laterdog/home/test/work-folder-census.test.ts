import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const program = readFileSync(new URL("../src/work-folder-census.program.txt", import.meta.url), "utf8");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

it.runIf(process.platform === "linux")("reads actual files including omitted cache directories and preserves raw links without following them", () => {
  const root = mkdtempSync(join(tmpdir(), "working-folder-census-"));
  const run = (request: object) => execFileSync(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify(request)], {
    env: { LATERDOG_CENSUS_ROOT: root }, stdio: ["ignore","pipe","pipe"],
  });
  try {
    mkdirSync(join(root, "code", ".cache"), { recursive: true });
    writeFileSync(join(root, "code", ".cache", "source"), "legacy code");
    writeFileSync(join(root, ".private"), "coordinator secret");
    linkSync(join(root, "code", ".cache", "source"), join(root, "code", "hard"));
    symlinkSync("../.private", join(root, "code", "outside"));
    mkdirSync(join(root, ".laterdog", "task-workspaces", "bot", "thread"), { recursive: true });
    const list = run({ op: "roots" }).toString().trim().split("\n").map(line => JSON.parse(line));
    expect(list.slice(0,-1)).toEqual([{ visible: ["code"] }, { dog: "bot", tasks: ["thread"] }]);
    const lines = run({ op: "scan", root: "code" }).toString().trimEnd().split("\n");
    const complete = JSON.parse(lines.pop()!);
    expect(complete).toEqual({ complete: true, count: lines.length, sha256: sha(lines.join("\n") + "\n") });
    const records = lines.map(line => JSON.parse(line));
    const original = records.find(entry => entry.path === ".cache/source");
    expect(original).toMatchObject({ type: "file", size: 11, sha256: sha("legacy code"), chunks: [sha("legacy code")], links: 2 });
    expect(records.find(entry => entry.path === "hard").inode).toBe(original.inode);
    expect(records.find(entry => entry.path === "outside")).toMatchObject({type:"link",target:"../.private"});
    expect(run({ op: "piece", root: "code", path: "hard", index: 0, hash: sha("legacy code") }).toString()).toBe("legacy code");
    expect(() => run({ op: "piece", root: "code", path: "outside", index: 0, hash: sha("coordinator secret") })).toThrow();
    expect(() => run({ op: "piece", root: "code", path: "hard", index: 0, hash: sha("stale block") })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
