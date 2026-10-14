import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { sipsShrinker, type ShrinkRunner } from "./clef-image-shrink.ts";

describe("sipsShrinker", () => {
  it("tries smaller sizes until the picture fits, and gives back a JPEG", async () => {
    const sizes: string[] = [];
    const runner: ShrinkRunner = async (command, args) => {
      expect(command).toBe("sips");
      sizes.push(args[1]!);
      const { writeFile } = await import("node:fs/promises");
      const output = args[args.indexOf("--out") + 1]!;
      await writeFile(output, Buffer.alloc(sizes.length < 3 ? 5_000 : 500, 1));
    };
    const shrink = sipsShrinker(runner, "darwin");
    const result = await shrink(Buffer.from("png"), "image/png", 1_000);
    expect(sizes).toEqual(["1280", "1024", "800"]);
    expect(result?.mime).toBe("image/jpeg");
    expect(result?.bytes.length).toBe(500);
  });

  it("gives up when nothing fits, on other systems, for other types, and when sips fails", async () => {
    const big: ShrinkRunner = async (_command, args) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.indexOf("--out") + 1]!, Buffer.alloc(5_000));
    };
    expect(await sipsShrinker(big, "darwin")(Buffer.from("x"), "image/png", 1_000)).toBeNull();
    expect(await sipsShrinker(big, "linux")(Buffer.from("x"), "image/png", 10_000)).toBeNull();
    expect(await sipsShrinker(big, "darwin")(Buffer.from("x"), "image/gif", 10_000)).toBeNull();
    const failing: ShrinkRunner = async () => { throw new Error("no sips"); };
    expect(await sipsShrinker(failing, "darwin")(Buffer.from("x"), "image/png", 10_000)).toBeNull();
  });

  it("leaves no temporary files behind", async () => {
    let dir = "";
    const runner: ShrinkRunner = async (_command, args) => {
      const output = args[args.indexOf("--out") + 1]!;
      dir = output.slice(0, output.lastIndexOf("/"));
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, Buffer.alloc(10));
    };
    await sipsShrinker(runner, "darwin")(Buffer.from("x"), "image/jpeg", 1_000);
    await expect(readFile(`${dir}/out.jpg`)).rejects.toThrow();
  });
});
