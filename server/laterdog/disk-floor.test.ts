import { describe, expect, it } from "vitest";
import { DISK_RUNGS, diskLadder, diskRung } from "./disk-ladder.ts";
import { diskFloorDecision, diskFloorRefusal, FLOOR_SENTENCE, floorWatch, writesOnHome } from "./disk-floor.ts";

const GB = 1024 ** 3;
const TOTAL = 19.2 * GB;
const at = (share: number) => diskRung({ totalBytes: TOTAL, freeBytes: share * TOTAL });

describe("the upper rungs of the disk ladder", () => {
  it("reaches refuse under 10% and the floor under 5% or 1 GB", () => {
    const rung = (name: string) => DISK_RUNGS.find((step) => step.name === name)!.rung;
    expect(at(0.11)).toBeLessThan(rung("refuse"));
    expect(at(0.09)).toBe(rung("refuse"));
    expect(at(0.049)).toBeGreaterThanOrEqual(rung("floor"));
    expect(diskRung({ totalBytes: 100 * GB, freeBytes: 0.9 * GB })).toBeGreaterThanOrEqual(rung("floor"));
    expect(diskRung({ totalBytes: 100 * GB, freeBytes: 8 * GB })).toBe(rung("refuse"));
  });

  it("lets everything through above the refuse rung", () => {
    for (const command of ["pnpm install", "git clone https://example.test/a.git", "cargo build", "echo hi > notes.txt"]) {
      expect(diskFloorRefusal(command, at(0.12), { computers: true }), command).toBeNull();
    }
  });

  it("refuses heavy commands outright at the refuse rung, every time, and sends them to the cloud computer", () => {
    for (const command of ["pnpm install", "npm run build", "cd app && pnpm test", "docker build .", "pip install torch"]) {
      const first = diskFloorRefusal(command, at(0.08), { computers: true });
      expect(first, command).toMatch(/run_on_computer/);
      expect(first).not.toMatch(/again/);
      expect(diskFloorRefusal(command, at(0.08), { computers: true }), command).toBe(first);
    }
  });

  it("at the refuse rung leaves ordinary commands alone", () => {
    for (const command of ["git status", "echo hi > notes.txt", "node script.js", "git clone https://example.test/a.git"]) {
      expect(diskFloorRefusal(command, at(0.08), { computers: true }), command).toBeNull();
    }
  });

  it("does not point a dog without a cloud computer at one", () => {
    const refusal = diskFloorRefusal("pnpm install", at(0.08), { computers: false });
    expect(refusal).not.toBeNull();
    expect(refusal).not.toMatch(/run_on_computer/);
  });

  it("at the floor lets through commands that only read or free space", () => {
    for (const command of [
      "ls -la", "cat package.json | head -20", "du -sh * | sort -h", "df -h", "rm -rf node_modules dist", "git status",
      "git -C repo log --oneline -5", "git diff HEAD~1", "git gc --prune=now", "git clean -fdx", "pnpm store prune",
      "grep -rn TODO src 2>/dev/null", "find . -name '*.log' -delete", "ps aux | grep vite", "kill 4242",
      "cd repo && git branch -a", "echo done", "wc -l src/*.ts > /dev/null 2>&1", "git config --get remote.origin.url",
    ]) expect(diskFloorRefusal(command, at(0.03), { computers: true }), command).toBeNull();
  });

  it("at the floor refuses anything that writes or is not known to only read", () => {
    for (const command of [
      "echo hi > notes.txt", "cat a >> b", "git clone https://example.test/a.git", "git commit -am wip", "git pull",
      "node build.js", "python3 script.py", "curl -o big.zip https://example.test/big.zip", "touch x", "cp -r a b",
      "pnpm install", "sed -i s/a/b/ file", "ls | tee listing.txt", "git checkout -b next", "mkdir out",
      "ls && npm run dev", "git config user.name Dog",
    ]) expect(diskFloorRefusal(command, at(0.03), { computers: true }), command).toMatch(/nearly full/);
  });

  it("names what still works and never tells the dog to remove the person's work", () => {
    const refusal = diskFloorRefusal("node build.js", at(0.03), { computers: true })!;
    expect(refusal).toMatch(/run_on_computer/);
    expect(refusal).toMatch(/not remove/i);
  });

  it("reads only shell commands from the hook payload", () => {
    const shell = { tool_name: "Bash", tool_input: { command: "touch x" } };
    expect(diskFloorDecision(shell, at(0.03), { computers: true })).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(diskFloorDecision({ tool_name: "Read", tool_input: { file_path: "x" } }, at(0.03), { computers: true })).toBeNull();
    expect(diskFloorDecision(shell, at(0.5), { computers: true })).toBeNull();
  });

  it("knows a redirect to a file from one to nowhere", () => {
    expect(writesOnHome("ls > out.txt")).toBe(true);
    expect(writesOnHome("ls 2> errors.txt")).toBe(true);
    expect(writesOnHome("ls >/dev/null 2>&1")).toBe(false);
    expect(writesOnHome("ls &> /dev/null")).toBe(false);
    expect(writesOnHome("echo 'a > b'")).toBe(false);
    expect(writesOnHome("echo hi >&2")).toBe(false);
  });
});

describe("the one sentence the person sees about disk", () => {
  function ladderAt(start: number, afterPrune = start) {
    let free = start;
    const ran: string[] = [];
    const disk = () => ({ totalBytes: TOTAL, freeBytes: free * TOTAL });
    const ladder = diskLadder({
      disk,
      chats: () => [],
      live: () => [],
      sweepTemp: () => { ran.push("sweep"); return { removed: [], freed: 0 }; },
      pruneCaches: () => { ran.push("prune"); free = afterPrune; return 0; },
      log: () => {},
    });
    return { ladder, disk, ran };
  }

  it("is shown only when the floor holds after a pass that ran every rung", () => {
    const { ladder, disk, ran } = ladderAt(0.03);
    const watch = floorWatch();
    expect(watch.warning(disk())).toBeNull();
    watch.climbed(ladder.climb());
    expect(ran).toEqual(expect.arrayContaining(["sweep", "prune"]));
    expect(watch.warning(disk())).toBe(FLOOR_SENTENCE);
  });

  it("is not shown when the rungs freed enough, above the floor, or once space comes back", () => {
    const freed = ladderAt(0.03, 0.2);
    const watch = floorWatch();
    watch.climbed(freed.ladder.climb());
    expect(watch.warning(freed.disk())).toBeNull();
    const refuse = ladderAt(0.08);
    watch.climbed(refuse.ladder.climb());
    expect(watch.warning(refuse.disk())).toBeNull();
    const stuck = ladderAt(0.03);
    watch.climbed(stuck.ladder.climb());
    expect(watch.warning({ totalBytes: TOTAL, freeBytes: 0.3 * TOTAL })).toBeNull();
  });

  it("is the sentence the person was promised, word for word", () => {
    expect(FLOOR_SENTENCE).toBe("Your Cloud is nearly full. later.dog has cleared everything it safely can; the rest is your dogs' work. Open Storage to choose what to remove.");
  });
});
