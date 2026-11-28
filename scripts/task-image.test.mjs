import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  antigravityFromSource,
  cliDirName,
  desktopImageFrom,
  enginesFromArg,
  enginesFromDockerfile,
  enginesFromImageConfig,
  freeAfter,
  muslEntries,
  repositoryOf,
  rewriteShim,
} from "./task-image.mjs";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

describe("the task image", () => {
  it("carries the engine versions the home image pins", () => {
    const engines = enginesFromDockerfile(read("../Dockerfile"));
    expect(engines.map((engine) => engine.name)).toEqual(["@anthropic-ai/claude-code", "@openai/codex"]);
    for (const engine of engines) expect(engine.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads the same pins from a built home image's history", () => {
    const config = { history: [{ created_by: "ARG ENGINES_CACHE_TAG=" }, { created_by: "RUN |6 GROK_VERSION=1.0.41 CLOUD_HOME_ENGINES=@anthropic-ai/claude-code@2.1.316 @openai/codex@0.163.0 ENGINES_CACHE_TAG= /bin/sh -c echo" }] };
    expect(enginesFromImageConfig(config)).toEqual([
      { name: "@anthropic-ai/claude-code", version: "2.1.316" },
      { name: "@openai/codex", version: "0.163.0" },
    ]);
    expect(() => enginesFromImageConfig({ history: [] })).toThrow(/names no CLOUD_HOME_ENGINES/);
  });

  it("refuses ranges and packages that are not engines", () => {
    expect(() => enginesFromArg("@anthropic-ai/claude-code@^2.1.0")).toThrow(/not an exact version/);
    expect(() => enginesFromArg("left-pad@1.3.0")).toThrow(/not an engine/);
    expect(() => enginesFromArg("@openai/codex")).toThrow();
  });

  it("puts each engine where the machine's prepare step looks for it", () => {
    expect(cliDirName({ name: "@anthropic-ai/claude-code", version: "2.1.316" })).toBe("claude-code-2.1.316");
    expect(cliDirName({ name: "@openai/codex", version: "0.163.0" })).toBe("codex-0.163.0");
    expect(cliDirName({ name: "@google/gemini-cli", version: "0.30.0" })).toBe("gemini-0.30.0");
    const prepare = read("../server/laterdog/engine-computer.ts");
    expect(prepare).toContain('`${REMOTE_ENGINE_BASE}/cli/${codex ? "codex" : "claude-code"}-${plan.cli.version}`');
    expect(read("../server/laterdog/guest-cli-runtime.ts")).toContain('"/home/dog/.laterdog-engine/cli"');
  });

  it("starts from the desktop image the computers Worker pins, and the pinned Antigravity release", () => {
    expect(desktopImageFrom(read("../deploy/laterdog/computers/wrangler.jsonc"))).toMatch(/dogcomputer-desktop@sha256:[0-9a-f]{64}$/);
    const release = antigravityFromSource(read("../server/drivers/antigravity-release.ts"));
    expect(release.url).toContain("linux-x86_64");
    expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rewrites staging paths in launcher shims, keeps only glibc packages, and names repositories", () => {
    expect(rewriteShim('export NODE_PATH="/tmp/x/root/home/dog/.laterdog-engine/cli/codex-1/node_modules"', "/tmp/x/root/home/dog/.laterdog-engine/cli/codex-1", "/home/dog/.laterdog-engine/cli/codex-1")).toBe('export NODE_PATH="/home/dog/.laterdog-engine/cli/codex-1/node_modules"');
    expect(muslEntries(["@anthropic-ai+claude-code-linux-x64@2.1.316", "@anthropic-ai+claude-code-linux-x64-musl@2.1.316"])).toEqual(["@anthropic-ai+claude-code-linux-x64-musl@2.1.316"]);
    expect(repositoryOf("registry.example/acct/repo@sha256:abc")).toBe("registry.example/acct/repo");
    expect(repositoryOf("registry.example/acct/repo:tag")).toBe("registry.example/acct/repo");
    expect(freeAfter(2_182_514_657, 8e9) >= 4e9).toBe(true);
  });
});
