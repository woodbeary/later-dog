import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE = /\.(ts|tsx)$/;
const SKIPPED = /\.(test|e2e\.test|node-test)\.|\.d\.ts$/;
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/gm;
const BARE_IMPORT = /^[ \t]*import\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) && !SKIPPED.test(entry.name) ? [path] : [];
  });
}

function onlyTypes(clause: string): boolean {
  const names = /^\{([\s\S]*)\}$/.exec(clause.trim())?.[1];
  if (names === undefined) return false;
  const listed = names.split(",").map((name) => name.trim()).filter(Boolean);
  return listed.length > 0 && listed.every((name) => name.startsWith("type "));
}

export function importedPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) if (!match[1] && !onlyTypes(match[2] ?? "")) found.push(match[3]!);
  for (const match of text.matchAll(BARE_IMPORT)) found.push(match[1]!);
  for (const match of text.matchAll(DYNAMIC_IMPORT)) found.push(match[1]!);
  return found;
}

export function cyclesIn(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const order = new Map<string, number>();
  const lowest = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const cycles: string[][] = [];
  const visit = (start: string) => {
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    order.set(start, order.size);
    lowest.set(start, order.get(start)!);
    stack.push(start);
    stacked.add(start);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const edges = graph.get(frame.node) ?? [];
      if (frame.next < edges.length) {
        const target = edges[frame.next]!;
        frame.next += 1;
        if (!order.has(target)) {
          order.set(target, order.size);
          lowest.set(target, order.get(target)!);
          stack.push(target);
          stacked.add(target);
          work.push({ node: target, next: 0 });
        } else if (stacked.has(target)) {
          lowest.set(frame.node, Math.min(lowest.get(frame.node)!, order.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) lowest.set(parent.node, Math.min(lowest.get(parent.node)!, lowest.get(frame.node)!));
      if (lowest.get(frame.node) !== order.get(frame.node)) continue;
      const members: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        stacked.delete(member);
        members.push(member);
        if (member === frame.node) break;
      }
      if (members.length > 1 || edges.includes(frame.node)) cycles.push(members.sort());
    }
  };
  for (const node of graph.keys()) if (!order.has(node)) visit(node);
  return cycles.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

export function rendererImportCycles(root: string): string[][] {
  const source = resolve(root, "src");
  const files = sourceFiles(source);
  const known = new Set(files);
  const target = (from: string, specifier: string): string | undefined => {
    const base = specifier.startsWith("@/") ? join(source, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : undefined;
    if (base === undefined) return undefined;
    const bare = base.replace(/\.(js|ts|tsx)$/, "");
    return [`${bare}.ts`, `${bare}.tsx`, join(bare, "index.ts"), join(bare, "index.tsx")].find((candidate) => known.has(candidate));
  };
  const graph = new Map(files.map((file) => [file, [...new Set(importedPaths(readFileSync(file, "utf8")).map((specifier) => target(file, specifier)).filter((path): path is string => path !== undefined))]]));
  return cyclesIn(graph).map((members) => members.map((member) => relative(root, member)));
}
