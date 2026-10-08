import { describe, expect, it } from "vitest";
import { EXEC_DEFAULT_TIMEOUT_MS, SIZES, parseCreate, parseExec, parseIdempotencyKey, parsePath, parseRename } from "../src/inputs";

describe("parseCreate", () => {
  it("defaults to a standard computer", () => {
    expect(parseCreate(undefined)).toEqual({ ok: true, value: { size: "standard" } });
    expect(parseCreate({})).toEqual({ ok: true, value: { size: "standard" } });
  });
  it("accepts a name and each size", () => {
    expect(parseCreate({ name: "  Rex's computer ", size: "large" })).toEqual({ ok: true, value: { name: "Rex's computer", size: "large" } });
    for (const size of Object.keys(SIZES)) expect(parseCreate({ size })).toMatchObject({ ok: true, value: { size } });
  });
  it("maps sizes onto Cloudflare instance types", () => {
    expect(SIZES).toEqual({ small: "standard-1", standard: "standard-2", large: "standard-3" });
  });
  it("refuses unknown sizes and bad names", () => {
    expect(parseCreate({ size: "huge" })).toMatchObject({ ok: false, refusal: { status: 400, code: "invalid_size" } });
    expect(parseCreate({ size: "toString" })).toMatchObject({ ok: false, refusal: { code: "invalid_size" } });
    expect(parseCreate({ name: "" })).toMatchObject({ ok: false, refusal: { code: "invalid_name" } });
    expect(parseCreate({ name: "x".repeat(65) })).toMatchObject({ ok: false, refusal: { code: "invalid_name" } });
    expect(parseCreate({ name: "bell\u0007" })).toMatchObject({ ok: false, refusal: { code: "invalid_name" } });
    expect(parseCreate({ name: 7 })).toMatchObject({ ok: false, refusal: { code: "invalid_name" } });
    expect(parseCreate([])).toMatchObject({ ok: false, refusal: { code: "invalid_body" } });
    expect(parseCreate("standard")).toMatchObject({ ok: false, refusal: { code: "invalid_body" } });
  });
});

describe("parseRename", () => {
  it("needs a name", () => {
    expect(parseRename({ name: "Fido" })).toEqual({ ok: true, value: { name: "Fido" } });
    expect(parseRename({})).toMatchObject({ ok: false, refusal: { code: "invalid_body" } });
    expect(parseRename(undefined)).toMatchObject({ ok: false, refusal: { code: "invalid_body" } });
  });
});

describe("parseExec", () => {
  it("defaults the timeout to two minutes", () => {
    expect(parseExec({ command: "uname -a" })).toEqual({ ok: true, value: { command: "uname -a", timeoutMs: EXEC_DEFAULT_TIMEOUT_MS } });
  });
  it("accepts a timeout up to ten minutes and a cwd", () => {
    expect(parseExec({ command: "ls", timeoutMs: 600_000, cwd: "/tmp" })).toEqual({ ok: true, value: { command: "ls", timeoutMs: 600_000, cwd: "/tmp" } });
    expect(parseExec({ command: "ls", timeoutMs: 1000 })).toMatchObject({ ok: true, value: { timeoutMs: 1000 } });
  });
  it("refuses out-of-range timeouts", () => {
    for (const timeoutMs of [600_001, 999, 0, -5, 1.5, "100", Number.NaN]) {
      expect(parseExec({ command: "ls", timeoutMs }), String(timeoutMs)).toMatchObject({ ok: false, refusal: { code: "invalid_timeout" } });
    }
  });
  it("refuses empty, oversized or NUL-carrying commands", () => {
    expect(parseExec({ command: "  " })).toMatchObject({ ok: false, refusal: { code: "invalid_command" } });
    expect(parseExec({ command: "a".repeat(100_001) })).toMatchObject({ ok: false, refusal: { code: "invalid_command" } });
    expect(parseExec({ command: "echo \u0000" })).toMatchObject({ ok: false, refusal: { code: "invalid_command" } });
    expect(parseExec({ command: ["ls"] })).toMatchObject({ ok: false, refusal: { code: "invalid_command" } });
    expect(parseExec({ command: "ls", cwd: "" })).toMatchObject({ ok: false, refusal: { code: "invalid_cwd" } });
    expect(parseExec(null)).toMatchObject({ ok: false, refusal: { code: "invalid_body" } });
  });
});

describe("parsePath", () => {
  it("accepts absolute and home-relative file paths", () => {
    expect(parsePath("/home/dog/notes.txt")).toEqual({ ok: true, value: "/home/dog/notes.txt" });
    expect(parsePath("notes/today.md")).toEqual({ ok: true, value: "notes/today.md" });
  });
  it("refuses missing, directory-like and NUL paths", () => {
    expect(parsePath(null)).toMatchObject({ ok: false, refusal: { code: "invalid_path" } });
    expect(parsePath("")).toMatchObject({ ok: false, refusal: { code: "invalid_path" } });
    expect(parsePath("/home/dog/")).toMatchObject({ ok: false, refusal: { code: "invalid_path" } });
    expect(parsePath("a\u0000b")).toMatchObject({ ok: false, refusal: { code: "invalid_path" } });
    expect(parsePath("a".repeat(4097))).toMatchObject({ ok: false, refusal: { code: "invalid_path" } });
  });
});

describe("parseIdempotencyKey", () => {
  it("is optional and limited to visible ASCII", () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, value: undefined });
    expect(parseIdempotencyKey("create-rex-1")).toEqual({ ok: true, value: "create-rex-1" });
    expect(parseIdempotencyKey("")).toMatchObject({ ok: false });
    expect(parseIdempotencyKey("has space")).toMatchObject({ ok: false });
    expect(parseIdempotencyKey("x".repeat(201))).toMatchObject({ ok: false });
  });
});
