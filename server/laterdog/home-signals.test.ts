import { describe, expect, it } from "vitest";
import { signalDecision, signalRefusal, type SignalScene } from "./home-signals.ts";

const SERVER = 21;
const marks: Record<number, string | null> = { 1: null, 7: null, [SERVER]: null, 30: "chat-a", 40: "chat-a", 50: "chat-b", 60: null };
const scene: SignalScene = {
  mark: "chat-a",
  home: new Set([1, 7, SERVER]),
  markOf: (pid) => (pid in marks ? marks[pid] : undefined),
  serverPort: 8787,
};
const refused = (command: string) => signalRefusal(command, scene) !== null;

describe("a dog can never signal the home's server", () => {
  it("refuses the server, its launcher and pid 1, by any spelling of kill", () => {
    for (const command of [
      `kill ${SERVER}`, `kill -TERM ${SERVER}`, `kill -9 ${SERVER}`, `kill -s KILL ${SERVER}`, `kill -- ${SERVER}`,
      "kill 7", "kill -HUP 1", `sudo kill ${SERVER}`, `/bin/kill ${SERVER}`, `sleep 1 && kill ${SERVER}`,
      `bash -c "kill -TERM ${SERVER}"`, `sh -c 'echo bye; kill ${SERVER}'`,
    ]) expect(refused(command), command).toBe(true);
  });

  it("refuses signalling a group or every process", () => {
    for (const command of ["kill -9 -1", "kill -- -1", "kill 0", "kill -TERM -- -40", "kill -KILL -21"]) expect(refused(command), command).toBe(true);
  });

  it("refuses finding what to stop by name or by the server's port", () => {
    for (const command of [
      "kill $(pgrep -f node)", "kill -9 `pidof node`", "pgrep laterdog | xargs kill",
      "ps aux | grep node | awk '{print $2}' | xargs kill -9", "kill $(lsof -t -i:8787)", "fuser -k 8787/tcp; kill $(lsof -ti :8787)",
    ]) expect(refused(command), command).toBe(true);
  });

  it("refuses a process of the home that is not the server", () => {
    expect(refused("kill 60")).toBe(true);
  });

  it("refuses the home's own processes even when they carry this chat's mark or cannot be read", () => {
    const odd: SignalScene = { ...scene, home: new Set([1, 7, SERVER, 8]), markOf: (pid) => (pid === SERVER ? "chat-a" : pid === 8 ? undefined : scene.markOf(pid)) };
    expect(signalRefusal(`kill ${SERVER}`, odd)).toMatch(/home's own/);
    expect(signalRefusal("kill -9 8", odd)).toMatch(/home's own/);
  });

  it("refuses a kill started beside a background command", () => {
    for (const command of [`pnpm dev & kill ${SERVER}`, `sleep 1 & kill -9 ${SERVER}`, "pnpm dev & kill 50", "true &kill 7"]) expect(refused(command), command).toBe(true);
  });
});

describe("a dog can never signal another dog's processes", () => {
  it("refuses stopping by name, which reaches every dog", () => {
    for (const command of ['pkill -f "git grep"', "killall node", "pkill -u root", "/usr/bin/pkill sleep", "fuser -k 3000/tcp"]) expect(refused(command), command).toBe(true);
  });

  it("refuses a pid that belongs to another chat", () => {
    expect(signalRefusal("kill 50", scene)).toMatch(/belongs to another chat/);
  });
});

describe("a dog can still stop what it started", () => {
  it("allows its own pids, its jobs and a pid that no longer exists", () => {
    for (const command of [
      "kill 40", "kill -9 40", "kill 30 40", "kill %1", "kill $!", "kill $PID", "kill 99999",
      "kill $(lsof -t -i:3000)", "kill -l", "echo pkill is a word here", "git log --grep=kill",
    ]) expect(refused(command), command).toBe(false);
  });

  it("allows asking whether a process is alive, which signals nothing", () => {
    for (const command of [`kill -0 ${SERVER}`, "kill -0 50", "kill -s 0 50", "kill -n 0 1"]) expect(refused(command), command).toBe(false);
  });

  it("reads past a heredoc's body, which is text and runs nothing", () => {
    for (const command of [
      "cat <<'EOF'\npkill -f old\nEOF",
      "cat > notes.md <<EOF\nnever run killall\nkill 21\nEOF\necho done",
      "cat <<-END > x.sh\n\tkill -9 1\n\tEND",
    ]) expect(refused(command), command).toBe(false);
    expect(refused("cat <<EOF > x\nhi\nEOF\nkill 21")).toBe(true);
  });

  it("keeps a background redirect from splitting the command", () => {
    expect(refused("pnpm dev > dev.log 2>&1 & echo started")).toBe(false);
    expect(refused("pnpm dev &> dev.log & kill 21")).toBe(true);
  });

  it("says why and what to do instead, in one line, for a port too", () => {
    const route = " To stop your own process, find its pid with ps, or with lsof -ti :<port> for a port, then run kill <pid>.";
    expect(signalRefusal(`kill ${SERVER}`, scene)).toBe(`later.dog refused this: that process is the home's own, and stopping it cuts off every dog and the person.${route}`);
    for (const command of ["pkill -f vite", "lsof -ti:3000 | xargs kill", "fuser -k 3000/tcp"]) {
      const why = signalRefusal(command, scene)!;
      expect(why.endsWith(route), command).toBe(true);
      expect(why).not.toContain("\n");
    }
  });
});

describe("the engine's shell hook", () => {
  const payload = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

  it("denies the command with the reason", () => {
    expect(signalDecision(payload(`kill -TERM ${SERVER}`), () => scene)).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  });

  it("does not look at the processes for a command that stops nothing", () => {
    let looked = false;
    expect(signalDecision(payload("ls -la"), () => { looked = true; return scene; })).toBeNull();
    expect(signalDecision({ tool_name: "Read", tool_input: { file_path: "/x" } }, () => { looked = true; return scene; })).toBeNull();
    expect(looked).toBe(false);
  });
});
