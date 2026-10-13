const VERSION = /\d+(?:\.\d+)*/;

export function modelLine(label: string): { line: string; version: number[] } {
  const name = label.trim().toLowerCase();
  const match = VERSION.exec(name);
  if (!match) return { line: name, version: [] };
  return { line: name.slice(0, match.index).replace(/[\s._-]+$/, "") || name, version: match[0].split(".").map(Number) };
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const step = (a[index] ?? 0) - (b[index] ?? 0);
    if (step !== 0) return step;
  }
  return 0;
}

export function newestOfLine<T>(entries: readonly T[], label: (entry: T) => string): (entry: T) => boolean {
  const newest = new Map<string, number[]>();
  for (const entry of entries) {
    const { line, version } = modelLine(label(entry));
    const best = newest.get(line);
    if (!best || compareVersions(version, best) > 0) newest.set(line, version);
  }
  return (entry) => {
    const { line, version } = modelLine(label(entry));
    return compareVersions(version, newest.get(line) ?? version) >= 0;
  };
}
