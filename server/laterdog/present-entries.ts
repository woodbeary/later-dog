import { lstatSync, readdirSync, type Stats } from "node:fs";

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function presentEntry(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if (gone(error)) return null; throw error; }
}

export function presentNames(directory: string): string[] {
  try { return readdirSync(directory); }
  catch (error) { if (gone(error)) return []; throw error; }
}

export function unlessGone<T>(path: string, read: () => T, forget: () => void): T | null {
  try { return read(); }
  catch (error) {
    if (!gone(error) || presentEntry(path)) throw error;
    forget();
    return null;
  }
}
