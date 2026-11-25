import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LEASES = "server/testing/ports.ts";
const THIS_GUARD = "scripts/test-ports.test.ts";

const PORT_NAME = String.raw`(?:\b[pP]ort|PORT|Port|_port)s?(?![a-z])`;
const RANDOM = String.raw`\b(?:Math\.random|randomInt)\(`;
const PORT_FROM_RANDOM = new RegExp(`${PORT_NAME}.*${RANDOM}|${RANDOM}.*${PORT_NAME}`);
const FIXED_LISTEN = /\.listen\(\s*(?:[1-9][\d_]*\b|\{[^}]*\bport\s*:\s*[1-9][\d_]*\b)/;

const STILL_PICKING_THEIR_OWN: string[] = [];

function portOffences(file: string, source: string): string[] {
  if (file === LEASES || file === THIS_GUARD) return [];
  return source
    .split("\n")
    .flatMap((line, index) =>
      PORT_FROM_RANDOM.test(line) || FIXED_LISTEN.test(line)
        ? [`${file}:${index + 1} ${line.trim()}`]
        : [],
    );
}

function testFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        /\.test\.(?:[cm]?[jt]sx?)$/.test(file) ||
        /(?:^|\/)testing\/[^/]+\.(?:[cm]?[jt]sx?)$/.test(file) ||
        /^scripts\/smoke-[^/]+\.(?:[cm]?[jt]s)$/.test(file),
    );
}

describe("test ports come from leases", () => {
  it("finds the files it guards", () => {
    const files = testFiles();
    expect(files).toContain("server/index.test.ts");
    expect(files).toContain("server/testing/setup.ts");
    expect(files).toContain("scripts/smoke-packaged-server.mjs");
  });

  it("has no test that picks a random port or listens on a fixed one instead of leasing it from server/testing/ports.ts or listening on 0", () => {
    const offenders = testFiles().flatMap((file) => portOffences(file, readFileSync(file, "utf8")));
    const files = [
      ...new Set(offenders.map((offence) => offence.slice(0, offence.indexOf(":")))),
    ].sort();
    expect(
      files,
      `Lease ports with leasePort or leasePortBlock from ${LEASES}, or listen on 0:\n${offenders.join("\n")}`,
    ).toEqual(STILL_PICKING_THEIR_OWN);
  });

  it("recognises the ways a test can pick its own port", () => {
    const offences = (source: string) => portOffences("a.test.ts", source);
    expect(offences("const PORT = 18800 + Math.floor(Math.random() * 10_000);")).toHaveLength(1);
    expect(offences("const port = randomInt(20_000, 30_000);")).toHaveLength(1);
    expect(
      offences("const webhookPort = 39000 + Math.floor(Math.random() * 10_000);"),
    ).toHaveLength(1);
    expect(offences('server.listen(8080, "127.0.0.1");')).toHaveLength(1);
    expect(offences('server.listen({ host: "127.0.0.1", port: 4000 });')).toHaveLength(1);
    expect(offences('server.listen(0, "127.0.0.1");')).toEqual([]);
    expect(offences("server.listen({ port: 0 });")).toEqual([]);
    expect(offences("const PORT = await leasePortBlock([0, 1]);")).toEqual([]);
    expect(offences("const file = `ledger-${Math.random().toString(36)}.json`;")).toEqual([]);
    expect(offences("export const report = { id: Math.random() };")).toEqual([]);
    expect(
      offences('expect(serviceServeArgs({ port: 8799 })).toEqual(["--port", "8799"]);'),
    ).toEqual([]);
    expect(
      portOffences(
        LEASES,
        "const base = 19_600 + Math.floor(Math.random() * span); const port = base;",
      ),
    ).toEqual([]);
  });
});
