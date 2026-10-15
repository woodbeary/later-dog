import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const expectLeak = process.argv.includes("--expect-leak");
const SETTLE_MS = 5_000;

function pidOneName() {
  try {
    return readFileSync("/proc/1/comm", "utf8").trim();
  } catch {
    return "unknown";
  }
}

function zombiesIn(group) {
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" && Number(fields[2]) === group) found.push(Number(entry));
    } catch {}
  }
  return found;
}

function groupGone(group) {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

const leader = spawn("sh", ["-c", "sh -c 'sleep 300 &'; sleep 300"], { detached: true, stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 500));
const group = leader.pid;
process.kill(-group, "SIGKILL");
const deadline = Date.now() + SETTLE_MS;
let gone = groupGone(group);
while (!gone && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  gone = groupGone(group);
}
const result = { pidOne: pidOneName(), groupGone: gone, zombies: zombiesIn(group), expectLeak };
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(gone === !expectLeak ? 0 : 1);
