import { desktopSupervisorToken, supervisorOrigin } from "./config.ts";

export const REPOSITORIES_ENV = "LATERDOG_REPOSITORIES";

export interface ConnectedRepositories {
  known(): readonly string[];
  checked(): boolean;
  refresh(): Promise<readonly string[]>;
  forget(): void;
}

export async function supervisorRepositorySlugs(): Promise<string[]> {
  const response = await fetch(`${supervisorOrigin()}/v1/workspace`, {
    headers: { authorization: `Bearer ${desktopSupervisorToken()}` },
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return [];
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
): ConnectedRepositories {
  let slugs: readonly string[] = [];
  let checkedAt = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let pending: Promise<readonly string[]> | null = null;
  return {
    known: () => slugs,
    checked: () => checkedAt !== Number.NEGATIVE_INFINITY,
    refresh() {
      if (now() - checkedAt < freshForMs) return Promise.resolve(slugs);
      if (pending) return pending;
      const started = generation;
      const current: Promise<readonly string[]> = read().catch(() => []).then((found) => {
        if (started === generation) { slugs = [...found]; checkedAt = now(); }
        if (pending === current) pending = null;
        return found;
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

export const connectedRepositories = createConnectedRepositories();

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
