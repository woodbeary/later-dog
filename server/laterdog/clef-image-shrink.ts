import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageShrinker } from "./clef-images.ts";

export interface ShrinkRunner {
  (command: string, args: string[]): Promise<void>;
}

const STEPS: ReadonlyArray<{ longest: number; quality: number }> = [
  { longest: 1280, quality: 60 },
  { longest: 1024, quality: 55 },
  { longest: 800, quality: 50 },
  { longest: 640, quality: 45 },
];

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const runSips: ShrinkRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000 }, (error) => (error ? reject(error) : resolve()));
  });

export function sipsShrinker(run: ShrinkRunner = runSips, platform: string = process.platform): ImageShrinker {
  return async (bytes, mime, maxBytes) => {
    const extension = EXTENSION[mime];
    if (platform !== "darwin" || !extension) return null;
    const dir = await mkdtemp(join(tmpdir(), "laterdog-clef-shrink-"));
    try {
      const input = join(dir, `in.${extension}`);
      const output = join(dir, "out.jpg");
      await writeFile(input, bytes, { mode: 0o600 });
      for (const step of STEPS) {
        await run("sips", ["-Z", String(step.longest), "-s", "format", "jpeg", "-s", "formatOptions", String(step.quality), input, "--out", output]);
        const shrunk = await readFile(output);
        if (shrunk.length <= maxBytes) return { bytes: shrunk, mime: "image/jpeg" };
      }
      return null;
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
