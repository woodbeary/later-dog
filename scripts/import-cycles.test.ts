import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cyclesIn, importedPaths, rendererImportCycles } from "./import-cycles.ts";

describe("renderer import cycles", () => {
  it("reads the imports that load a module and skips the ones that only name types", () => {
    const text = [
      'import { useState } from "react";',
      'import type { Bot } from "@/state/store";',
      'import { type Thread } from "./thread";',
      'import { type Draft, saveDraft } from "./drafts";',
      "import {",
      "  open,",
      "  close,",
      '} from "./sheet";',
      'export { pill } from "./pill";',
      'export * from "./all";',
      'import "./styles.css";',
      'const Screen = lazy(() => import("./Screen"));',
    ].join("\n");
    expect(importedPaths(text)).toEqual(["react", "./drafts", "./sheet", "./pill", "./all", "./styles.css", "./Screen"]);
  });

  it("finds a loop of two, a longer loop and a module that imports itself, and nothing in a tree", () => {
    const graph = new Map<string, string[]>([
      ["app", ["panel", "list"]],
      ["panel", ["account"]],
      ["account", ["panel"]],
      ["list", ["row"]],
      ["row", ["cell"]],
      ["cell", ["list", "leaf"]],
      ["leaf", []],
      ["self", ["self"]],
    ]);
    expect(cyclesIn(graph)).toEqual([["account", "panel"], ["cell", "list", "row"], ["self"]]);
  });

  it("the renderer has none, because one save inside a loop can redraw the hot-reload window without end", () => {
    expect(rendererImportCycles(resolve(import.meta.dirname, ".."))).toEqual([]);
  });
});
