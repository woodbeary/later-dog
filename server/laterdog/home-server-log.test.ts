import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeServerLog, installHomeServerLog, maskHomeLogLine, parseHomeLogQuery, readHomeLog, segmentName } from "./home-server-log.ts";

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "home-server-log-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const clock = (start = Date.parse("2026-11-25T10:00:00.000Z")) => {
  let at = start;
  return () => new Date((at += 1000));
};
const segments = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("server-")).sort((a, b) => Number(a.slice(7, -4)) - Number(b.slice(7, -4)));

describe("the home server log", () => {
  it("stamps each line with UTC time and keeps its own text", async () => {
    const dir = join(folder(), "logs");
    const log = createHomeServerLog({ dir, now: clock() });
    log.write("[log archive] no room to bring saved logs back\nsecond line\n", "stderr");
    await log.flush();
    expect(readFileSync(join(dir, segmentName(1)), "utf8")).toBe(
      "2026-11-25T10:00:01.000Z [log archive] no room to bring saved logs back\n2026-11-25T10:00:02.000Z second line\n");
  });

  it("joins a line written in parts and keeps the streams apart", async () => {
    const dir = folder();
    const log = createHomeServerLog({ dir, now: clock() });
    log.write("start of ", "stdout");
    log.write(Buffer.from("an error\n"), "stderr");
    log.write("the line\n", "stdout");
    await log.flush();
    expect(readFileSync(join(dir, segmentName(1)), "utf8")).toBe(
      "2026-11-25T10:00:02.000Z an error\n2026-11-25T10:00:01.000Z start of the line\n");
  });

  it("writes an unfinished line when it stops", async () => {
    const dir = folder();
    const log = createHomeServerLog({ dir, now: clock() });
    log.write("stopping without a newline");
    await log.flush();
    expect(readFileSync(join(dir, segmentName(1)), "utf8")).toBe("2026-11-25T10:00:01.000Z stopping without a newline\n");
  });

  it("starts a new segment at the size limit and keeps only the newest", async () => {
    const dir = folder();
    const log = createHomeServerLog({ dir, now: clock(), segmentBytes: 100, segmentsKept: 3 });
    for (let i = 0; i < 20; i++) log.write(`line number ${String(i).padStart(2, "0")} of the test\n`);
    await log.flush();
    const names = segments(dir);
    expect(names).toHaveLength(3);
    for (const name of names) expect(readFileSync(join(dir, name)).length).toBeLessThanOrEqual(100);
    const all = names.map((name) => readFileSync(join(dir, name), "utf8")).join("");
    expect(all.trim().split("\n").at(-1)).toContain("line number 19");
    expect(all).not.toContain("line number 00");
  });

  it("carries on in the newest segment after a restart", async () => {
    const dir = folder();
    writeFileSync(join(dir, segmentName(7)), "2026-11-25T09:00:00.000Z before\n");
    const log = createHomeServerLog({ dir, now: clock() });
    log.write("after\n");
    await log.flush();
    expect(segments(dir)).toEqual([segmentName(7)]);
    expect(readFileSync(join(dir, segmentName(7)), "utf8")).toContain("after");
  });

  it("makes the folder when it is missing", async () => {
    const dir = join(folder(), "data", "logs");
    const log = createHomeServerLog({ dir, now: clock() });
    log.write("hello\n");
    await log.flush();
    expect(readFileSync(join(dir, segmentName(1)), "utf8")).toContain("hello");
  });

  it("never throws when the folder cannot be written and counts what it lost", async () => {
    const parent = folder();
    const dir = join(parent, "logs");
    writeFileSync(dir, "a file where the folder should be");
    const log = createHomeServerLog({ dir, now: clock() });
    expect(() => log.write("lost\n")).not.toThrow();
    await log.flush();
    expect(log.dropped()).toBe(1);
    expect(() => log.flushSync()).not.toThrow();
  });

  it("drops lines past the buffer and says how many once the disk catches up", async () => {
    const dir = folder();
    const log = createHomeServerLog({ dir, now: clock(), bufferBytes: 120 });
    for (let i = 0; i < 6; i++) log.write(`burst ${i} ${"x".repeat(20)}\n`);
    expect(log.dropped()).toBeGreaterThan(0);
    const lost = log.dropped();
    await log.flush();
    log.write("calm again\n");
    await log.flush();
    const text = readFileSync(join(dir, segmentName(1)), "utf8");
    expect(text).toContain(`home log: dropped ${lost} line${lost === 1 ? "" : "s"} because the disk fell behind`);
    expect(text).toContain("calm again");
  });

  it("writes what is still queued at once when the process exits", () => {
    const dir = folder();
    writeFileSync(join(dir, segmentName(4)), "");
    let atExit: (() => void) | null = null;
    const out = { write: (_chunk: string) => true };
    const err = { write: (_chunk: string) => true };
    const { uninstall } = installHomeServerLog({ dir, now: clock(), stdout: out, stderr: err, onExit: (run) => { atExit = run; } });
    out.write("last words\n");
    err.write("and a partial");
    atExit!();
    uninstall();
    const text = readFileSync(join(dir, segmentName(4)), "utf8");
    expect(text).toContain("last words");
    expect(text).toContain("and a partial");
  });

  it("passes every write through to the real stream", () => {
    const dir = folder();
    const seen: string[] = [];
    const out = { write: (chunk: string) => { seen.push(chunk); return true; } };
    const { uninstall } = installHomeServerLog({ dir, stdout: out, stderr: { write: () => true }, onExit: () => undefined });
    expect(out.write("shown\n")).toBe(true);
    uninstall();
    out.write("after\n");
    expect(seen).toEqual(["shown\n", "after\n"]);
  });
});

describe("masking secrets in the home log", () => {
  it("masks bearer tokens, session tokens and provider keys", () => {
    const session = `laterdog_sess_${"A".repeat(43)}`;
    const line = maskHomeLogLine(`auth Bearer abcdefghijklmnop12345 session ${session} key sk-${"b".repeat(40)} grok xai-${"c".repeat(40)}`);
    expect(line).not.toContain("abcdefghijklmnop12345");
    expect(line).not.toContain(session);
    expect(line).not.toContain("b".repeat(40));
    expect(line).not.toContain("c".repeat(40));
    expect(line).toContain("«redacted");
  });

  it("leaves ordinary lines alone", () => {
    const line = "[log archive] no room to bring saved logs back; making room and keeping the pending turn";
    expect(maskHomeLogLine(line)).toBe(line);
  });

  it("masks a secret before it is written", async () => {
    const dir = folder();
    const log = createHomeServerLog({ dir, now: clock() });
    log.write(`token laterdog_sess_${"z".repeat(43)}\n`);
    await log.flush();
    expect(readFileSync(join(dir, segmentName(1)), "utf8")).not.toContain("z".repeat(43));
  });
});

describe("reading the home log", () => {
  const fill = (dir: string) => {
    writeFileSync(join(dir, segmentName(1)), "2026-11-25T10:00:00.000Z one\n2026-11-25T10:01:00.000Z two archive\n");
    writeFileSync(join(dir, segmentName(2)), `2026-11-25T10:02:00.000Z three archive\n2026-11-25T10:03:00.000Z four Bearer ${"q".repeat(30)}\n`);
  };

  it("answers the newest lines last", async () => {
    const dir = folder();
    fill(dir);
    expect(await readHomeLog(dir, { lines: 3 })).toBe(
      `2026-11-25T10:01:00.000Z two archive\n2026-11-25T10:02:00.000Z three archive\n2026-11-25T10:03:00.000Z four Bearer «redacted 30 chars»\n`);
  });

  it("filters by text and by time", async () => {
    const dir = folder();
    fill(dir);
    expect(await readHomeLog(dir, { contains: "archive" })).toBe("2026-11-25T10:01:00.000Z two archive\n2026-11-25T10:02:00.000Z three archive\n");
    expect(await readHomeLog(dir, { since: "2026-11-25T10:02:00.000Z" })).toContain("three archive");
    expect(await readHomeLog(dir, { since: "2026-11-25T10:02:00.000Z" })).not.toContain("two");
  });

  it("answers nothing when there is no log yet", async () => {
    expect(await readHomeLog(join(folder(), "missing"))).toBe("");
  });

  it("caps and checks the query", () => {
    expect(parseHomeLogQuery(new URLSearchParams("lines=999999"))).toEqual({ lines: 2000 });
    expect(parseHomeLogQuery(new URLSearchParams("lines=abc"))).toBeTypeOf("string");
    expect(parseHomeLogQuery(new URLSearchParams("since=yesterday"))).toBeTypeOf("string");
    expect(parseHomeLogQuery(new URLSearchParams("since=2026-11-25T10:00:00Z&contains=x"))).toEqual({ since: "2026-11-25T10:00:00.000Z", contains: "x" });
  });
});
