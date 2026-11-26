const fsModule = "node:fs";
const { readFileSync } = await import(fsModule) as { readFileSync(file: URL, encoding: "utf8"): string };
const here = (import.meta as ImportMeta & { url: string }).url;

export function readContainerFile(path: string): string {
  return readFileSync(new URL(path, here), "utf8");
}
