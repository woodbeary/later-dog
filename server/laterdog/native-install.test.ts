import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_INSTALL_SCRIPT, CODEX_LATEST_RELEASE, defaultNativeDeps, installNative, nativeBinDir, nativeInstallFor, type NativeDeps } from "./native-install.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-native-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codexArchive(): { bytes: Buffer; sha256: string } {
  const dir = scratch();
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "codex-aarch64-apple-darwin"), "#!/bin/sh\necho codex-cli 9.9.9\n");
  const archive = join(dir, "codex.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", src, "codex-aarch64-apple-darwin"]);
  const bytes = readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as unknown as typeof fetch;
}

describe("installing Claude and ChatGPT without npm", () => {
  it("offers Anthropic's installer for Claude and OpenAI's release for Codex, on a Mac only", () => {
    expect(nativeInstallFor("claude", "darwin", "arm64")).toEqual({ kind: "claude-script" });
    expect(nativeInstallFor("codex", "darwin", "arm64")).toEqual({ kind: "codex-release", asset: "codex-aarch64-apple-darwin.tar.gz" });
    expect(nativeInstallFor("codex", "darwin", "x64")).toEqual({ kind: "codex-release", asset: "codex-x86_64-apple-darwin.tar.gz" });
    expect(nativeInstallFor("claude", "linux", "x64")).toBeNull();
    expect(nativeInstallFor("gemini", "darwin", "arm64")).toBeNull();
  });

  it("runs Claude's own install script with bash and nothing else", async () => {
    const run = vi.fn<NativeDeps["run"]>(async () => ({ code: 0, output: "Claude Code installed" }));
    const deps: NativeDeps = { fetch: fakeFetch({ [CLAUDE_INSTALL_SCRIPT]: () => new Response("#!/bin/bash\necho install\n") }), run };
    await installNative({ kind: "claude-script" }, { baseDir: scratch(), deps });
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe("/bin/bash");
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/install\.sh$/);
  });

  it("refuses to run a download that is not a script, and says when the script fails", async () => {
    const run = vi.fn<NativeDeps["run"]>(async () => ({ code: 0, output: "" }));
    await expect(installNative({ kind: "claude-script" }, { baseDir: scratch(), deps: { fetch: fakeFetch({ [CLAUDE_INSTALL_SCRIPT]: () => new Response("<html>") }), run } }))
      .rejects.toThrow("did not look like an install script");
    expect(run).not.toHaveBeenCalled();
    const failing = vi.fn<NativeDeps["run"]>(async () => ({ code: 1, output: "curl: (6) Could not resolve host" }));
    await expect(installNative({ kind: "claude-script" }, { baseDir: scratch(), deps: { fetch: fakeFetch({ [CLAUDE_INSTALL_SCRIPT]: () => new Response("#!/bin/bash\n") }), run: failing } }))
      .rejects.toThrow("Claude could not be installed. curl: (6) Could not resolve host");
  });

  it("installs Codex from its release only when the download matches GitHub's checksum", async () => {
    const { bytes, sha256 } = codexArchive();
    const asset = "codex-aarch64-apple-darwin.tar.gz";
    const url = "https://github.com/openai/codex/releases/download/rust-v9.9.9/" + asset;
    const release = (digest: string) => () => Response.json({ assets: [{ name: asset, browser_download_url: url, digest: `sha256:${digest}` }] });
    const baseDir = scratch();
    await installNative({ kind: "codex-release", asset }, { baseDir, deps: { fetch: fakeFetch({ [CODEX_LATEST_RELEASE]: release(sha256), [url]: () => new Response(bytes) }), run: defaultNativeDeps.run } });
    const installed = join(nativeBinDir(baseDir), "codex");
    expect(existsSync(installed)).toBe(true);
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(execFileSync(installed, ["--version"], { encoding: "utf8" }).trim()).toBe("codex-cli 9.9.9");

    const other = scratch();
    await expect(installNative({ kind: "codex-release", asset }, { baseDir: other, deps: { fetch: fakeFetch({ [CODEX_LATEST_RELEASE]: release("0".repeat(64)), [url]: () => new Response(bytes) }), run: defaultNativeDeps.run } }))
      .rejects.toThrow("did not match its published checksum");
    expect(existsSync(join(nativeBinDir(other), "codex"))).toBe(false);
  });
});
