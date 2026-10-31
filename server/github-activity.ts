import { runCommand, type CommandRunner } from "./laterdog/command.ts";

export interface GitHubDay { day: string; commits: number; prs: number }
export type GitHubActivity =
  | { state: "signedOut" }
  | { state: "ready"; login: string; today: string; days: GitHubDay[] }
  | { state: "unavailable"; message: string };

export interface SearchPage { total: number; stamps: string[] }
export type GitHubSearch = (kind: "commits" | "prs", login: string, from: string, to: string, page: number) => Promise<SearchPage>;

const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
const SEARCH_CAP = 1000;
const REQUEST_BUDGET = 25;
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const PAUSE_MS = 1500;

export function activityDays(today: string, count = 30): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

export function bucketByDay(days: readonly string[], stamps: readonly string[]): number[] {
  const index = new Map(days.map((day, at) => [day, at]));
  const counts = days.map(() => 0);
  for (const stamp of stamps) {
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    const slot = index.get(new Date(at).toISOString().slice(0, 10));
    if (slot !== undefined) counts[slot]! += 1;
  }
  return counts;
}

interface Budget { left: number; pauseMs: number; asked: number }

async function collect(search: GitHubSearch, kind: "commits" | "prs", login: string, days: readonly string[], budget: Budget): Promise<string[]> {
  const from = days[0]!;
  const to = days.at(-1)!;
  const stamps: string[] = [];
  for (let page = 1; page <= SEARCH_CAP / PAGE_SIZE; page += 1) {
    if (budget.left <= 0) throw new Error("GitHub search needed too many requests");
    budget.left -= 1;
    if (budget.asked > 0 && budget.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, budget.pauseMs));
    budget.asked += 1;
    const result = await search(kind, login, from, to, page);
    if (page === 1 && result.total > SEARCH_CAP && days.length > 1) {
      const half = Math.ceil(days.length / 2);
      return [
        ...await collect(search, kind, login, days.slice(0, half), budget),
        ...await collect(search, kind, login, days.slice(half), budget),
      ];
    }
    stamps.push(...result.stamps);
    if (result.stamps.length < PAGE_SIZE || stamps.length >= result.total) break;
  }
  return stamps;
}

export async function readGitHubActivity(login: string | null, search: GitHubSearch, today: string, pauseMs = 0): Promise<GitHubActivity> {
  if (!login) return { state: "signedOut" };
  const days = activityDays(today);
  const budget: Budget = { left: REQUEST_BUDGET, pauseMs, asked: 0 };
  const commits = bucketByDay(days, await collect(search, "commits", login, days, budget));
  const prs = bucketByDay(days, await collect(search, "prs", login, days, budget));
  return { state: "ready", login, today, days: days.map((day, at) => ({ day, commits: commits[at]!, prs: prs[at]! })) };
}

interface SearchBody { total_count?: number; items?: { created_at?: string; commit?: { author?: { date?: string } } }[] }

export function ghSearch(run: CommandRunner = runCommand): GitHubSearch {
  return async (kind, login, from, to, page) => {
    const commits = kind === "commits";
    const query = commits ? `author:${login} author-date:${from}..${to}` : `author:${login} type:pr created:${from}..${to}`;
    const result = await run("gh", ["api", "-X", "GET", commits ? "search/commits" : "search/issues",
      "-f", `q=${query}`, "-f", `per_page=${PAGE_SIZE}`, "-f", `page=${page}`,
      "-f", `sort=${commits ? "author-date" : "created"}`, "-f", "order=desc"], { timeoutMs: 30_000 });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr.trim().split("\n").at(-1) || "GitHub search failed");
    const body = JSON.parse(result.stdout) as SearchBody;
    const stamps = (body.items ?? []).map((item) => (commits ? item.commit?.author?.date : item.created_at)).filter((stamp): stamp is string => typeof stamp === "string");
    return { total: body.total_count ?? stamps.length, stamps };
  };
}

export async function ghLogin(run: CommandRunner = runCommand): Promise<string | null> {
  try {
    const result = await run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 30_000 });
    const login = result.stdout.trim();
    return result.exitCode === 0 && /^[A-Za-z0-9-]+$/.test(login) ? login : null;
  } catch {
    return null;
  }
}

export function createGitHubActivity(deps: { login?: () => Promise<string | null>; search?: GitHubSearch; now?: () => number; pauseMs?: number } = {}) {
  const login = deps.login ?? (() => ghLogin());
  const search = deps.search ?? ghSearch();
  const now = deps.now ?? Date.now;
  const pauseMs = deps.pauseMs ?? PAUSE_MS;
  let cached: { at: number; ttl: number; today: string; value: GitHubActivity } | null = null;
  let lastReady: Extract<GitHubActivity, { state: "ready" }> | null = null;
  let pending: Promise<GitHubActivity> | null = null;
  return {
    async read(): Promise<GitHubActivity> {
      const at = now();
      const today = new Date(at).toISOString().slice(0, 10);
      if (cached && cached.today === today && at - cached.at < cached.ttl) return cached.value;
      pending ??= (async () => {
        let value: GitHubActivity;
        let failed = false;
        try {
          value = await readGitHubActivity(await login(), search, today, pauseMs);
        } catch (error) {
          failed = true;
          value = lastReady?.today === today ? lastReady : { state: "unavailable", message: error instanceof Error ? error.message : String(error) };
        }
        if (value.state === "ready") lastReady = value;
        else if (!failed) lastReady = null;
        cached = { at, ttl: failed ? RETRY_MS : FRESH_MS, today, value };
        return value;
      })().finally(() => { pending = null; });
      return lastReady?.today === today ? lastReady : pending;
    },
  };
}
