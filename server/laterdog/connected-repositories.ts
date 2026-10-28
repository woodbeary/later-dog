import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { connectedRepositoriesFile, desktopSupervisorToken, supervisorOrigin } from "./config.ts";

export const REPOSITORIES_ENV = "LATERDOG_REPOSITORIES";

export interface ConnectedRepositories {
  known(): readonly string[];
  checked(): boolean;
  refresh(): Promise<readonly string[]>;
  forget(): void;
}

export interface SavedRepositories {
  load(): readonly string[] | null;
  save(slugs: readonly string[]): void;
}

export function savedRepositoriesFile(file: string): SavedRepositories {
  return {
    load() {
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(value) && value.every((slug) => typeof slug === "string") ? value : null;
      } catch {
        return null;
      }
    },
    save(slugs) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileAtomic(file, JSON.stringify(slugs), { mode: 0o600 });
      } catch {}
    },
  };
}

export async function supervisorRepositorySlugs(): Promise<string[]> {
  const response = await fetch(`${supervisorOrigin()}/v1/workspace`, {
    headers: { authorization: `Bearer ${desktopSupervisorToken()}` },
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`the supervisor answered ${response.status}`);
  const body = await response.json() as { repositories?: unknown };
  return Array.isArray(body.repositories)
    ? body.repositories.flatMap((repository: unknown) => {
      const slug = repository && typeof repository === "object" ? (repository as { slug?: unknown }).slug : undefined;
      return typeof slug === "string" && slug ? [slug] : [];
    })
    : [];
}

export function createConnectedRepositories(
  read: () => Promise<readonly string[]> = supervisorRepositorySlugs,
  freshForMs = 15_000,
  now: () => number = Date.now,
  saved?: SavedRepositories,
): ConnectedRepositories {
  const remembered = saved?.load() ?? null;
  let slugs: readonly string[] = remembered ?? [];
  let checkedAt = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let pending: Promise<readonly string[]> | null = null;
  return {
    known: () => slugs,
    checked: () => checkedAt !== Number.NEGATIVE_INFINITY || remembered !== null,
    refresh() {
      if (now() - checkedAt < freshForMs) return Promise.resolve(slugs);
      if (pending) return pending;
      const started = generation;
      const current: Promise<readonly string[]> = read().then(
        (found) => {
          if (started === generation) {
            slugs = [...found];
            checkedAt = now();
            saved?.save(slugs);
          }
          return found;
        },
        () => {
          if (started === generation) checkedAt = now();
          return slugs;
        },
      ).finally(() => {
        if (pending === current) pending = null;
      });
      pending = current;
      return current;
    },
    forget() {
      generation += 1;
      checkedAt = Number.NEGATIVE_INFINITY;
      pending = null;
    },
  };
}

export const connectedRepositories = createConnectedRepositories(
  supervisorRepositorySlugs, 15_000, Date.now, savedRepositoriesFile(connectedRepositoriesFile()),
);

export async function repositoriesForTurn(repositories: ConnectedRepositories = connectedRepositories): Promise<readonly string[]> {
  if (!repositories.checked()) return repositories.refresh();
  void repositories.refresh();
  return repositories.known();
}

export function repositoriesEnvironment(slugs: readonly string[]): Record<string, string> {
  return slugs.length ? { [REPOSITORIES_ENV]: slugs.join(",") } : {};
}

export function repositoriesFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  return (env[REPOSITORIES_ENV] ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
}
