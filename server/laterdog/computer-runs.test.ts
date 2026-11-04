import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bringBackList, changesSince, ComputerRuns, parts, type RunBox, stampFolder } from "./computer-runs.ts";

function localBox(home: string) {
  const commands: string[] = [];
  const box: RunBox = {
    async exec(command) {
      commands.push(command);
      const out = spawnSync("bash", ["-c", command], { cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8" });
      return { exitCode: out.status, stdout: out.stdout, stderr: out.stderr };
    },
    async write(path, bytes) {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      writeFileSync(join(home, path), bytes);
    },
    async read(path) { return readFileSync(join(home, path)); },
  };
  return { box, commands };
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "computer-runs-"));
  const folder = join(root, "site");
  mkdirSync(join(folder, "src"), { recursive: true });
  mkdirSync(join(folder, "node_modules/react"), { recursive: true });
  writeFileSync(join(folder, "package.json"), "{}");
  writeFileSync(join(folder, "src/page.ts"), "export const page = 1;\n");
  writeFileSync(join(folder, "node_modules/react/index.js"), "x".repeat(1000));
  const old = new Date(Date.now() - 60_000);
  for (const path of ["package.json", "src/page.ts"]) utimesSync(join(folder, path), old, old);
  return { root, folder, computer: join(root, "computer"), state: join(root, "state") };
}

const fast = { sleep: async () => undefined };

describe("a heavy command on the dog's own computer", () => {
  it("sends the folder without build output, runs the command there and brings back only what it made", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const outcome = await runs.run(box, { botId: "dog", folder, command: "mkdir -p dist report && echo built > dist/app.js && echo 'all 12 tests passed' | tee report/result.txt && echo changed > src/page.ts" });
    expect(outcome.state).toBe("finished");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain("all 12 tests passed");
    expect(outcome.sentFiles).toBe(2);
    expect(outcome.broughtBack.sort()).toEqual(["report/result.txt", "src/page.ts"]);
    expect(readFileSync(join(folder, "src/page.ts"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(folder, "report/result.txt"), "utf8")).toBe("all 12 tests passed\n");
    expect(existsSync(join(folder, "dist"))).toBe(false);
  });

  it("sends only what changed the next time, removes deleted files there, and reports a failing command", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    await runs.run(box, { botId: "dog", folder, command: "true" });
    writeFileSync(join(folder, "src/new.ts"), "export {};\n");
    spawnSync("rm", [join(folder, "package.json")]);
    const outcome = await runs.run(box, { botId: "dog", folder, subdir: "src", command: "ls; ls .. ; exit 3" });
    expect(outcome.sentFiles).toBe(1);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.output).toContain("new.ts");
    expect(outcome.output).not.toContain("package.json");
  });

  it("keeps the home's copy of a file someone changed here while the command ran", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    const runs = new ComputerRuns(state, fast);
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 1; echo theirs > src/page.ts" });
    writeFileSync(join(folder, "src/page.ts"), "mine\n");
    const outcome = await runs.finish(box, started);
    expect(outcome.broughtBack).toEqual([]);
    expect(outcome.note).toContain("src/page.ts");
    expect(readFileSync(join(folder, "src/page.ts"), "utf8")).toBe("mine\n");
  });

  it("hands back a run id while the command is still going, and finishes it on the next call", async () => {
    const { folder, computer, state } = project();
    mkdirSync(computer);
    const { box } = localBox(computer);
    let clock = 0;
    const runs = new ComputerRuns(state, { now: () => clock, sleep: async () => { clock += 10 * 60_000; } });
    const started = await runs.start(box, { botId: "dog", folder, command: "sleep 2; echo done > out.txt" });
    const first = await runs.finish(box, started);
    expect(first.state).toBe("running");
    expect(first.note).toContain(started.id);
    const record = runs.record("dog", started.id)!;
    await new Promise((done) => setTimeout(done, 2500));
    const second = await runs.finish(box, record);
    expect(second.state).toBe("finished");
    expect(readFileSync(join(folder, "out.txt"), "utf8")).toBe("done\n");
  });
});

describe("the pieces", () => {
  it("compares folder stamps and skips build output", () => {
    const { folder } = project();
    const stamps = stampFolder(folder);
    expect(Object.keys(stamps).sort()).toEqual(["package.json", "src/page.ts"]);
    expect(changesSince({ "a": { size: 1, mtimeMs: 1 }, "b": { size: 1, mtimeMs: 1 } }, { "a": { size: 2, mtimeMs: 1 }, "c": { size: 1, mtimeMs: 1 } })).toEqual({ changed: ["a", "c"], removed: ["b"] });
  });

  it("brings back files up to the size limit and never build output or paths that leave the folder", () => {
    expect(bringBackList("10\t./a.txt\n5\t./node_modules/x.js\n7\t./../escape\n20\t./big.bin\n3\t./c.txt\n", 15)).toEqual({ take: ["a.txt", "c.txt"], skipped: ["big.bin"] });
  });

  it("splits large archives into parts the computer accepts", () => {
    expect(parts(Buffer.alloc(25), 10).map((part) => part.length)).toEqual([10, 10, 5]);
    expect(parts(Buffer.alloc(0), 10)).toHaveLength(1);
  });
});
