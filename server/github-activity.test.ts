import { describe, expect, it, vi } from "vitest";
import { activityDays, bucketByDay, createGitHubActivity, ghLogin, ghSearch, readGitHubActivity, type GitHubSearch } from "./github-activity.ts";
import type { CommandRunner } from "./laterdog/command.ts";

const TODAY = "2026-10-30";

describe("commits and PRs a day", () => {
  it("covers the last 30 days ending today", () => {
    const days = activityDays(TODAY);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-10-01");
    expect(days.at(-1)).toBe(TODAY);
  });

  it("buckets each stamp into its UTC day and drops ones outside the window", () => {
    const days = ["2026-10-28", "2026-10-29", "2026-10-30"];
    expect(bucketByDay(days, [
      "2026-10-29T23:30:00.000-04:00",
      "2026-10-30T01:00:00Z",
      "2026-10-28T10:00:00Z",
      "2026-10-28T11:00:00Z",
      "2026-09-01T00:00:00Z",
      "not a date",
    ])).toEqual([2, 0, 2]);
  });

  it("counts commits and PRs per day across pages", async () => {
    const commitStamps = Array.from({ length: 150 }, (_, at) => (at < 100 ? "2026-10-30T12:00:00Z" : "2026-10-29T12:00:00Z"));
    const search: GitHubSearch = vi.fn(async (kind, _login, _from, _to, page) => kind === "commits"
      ? { total: 150, stamps: commitStamps.slice((page - 1) * 100, page * 100) }
      : { total: 1, stamps: ["2026-10-30T08:00:00Z"] });
    const activity = await readGitHubActivity("dogfan", search, TODAY);
    expect(activity.state).toBe("ready");
    if (activity.state !== "ready") return;
    expect(activity.days.at(-1)).toEqual({ day: TODAY, commits: 100, prs: 1 });
    expect(activity.days.at(-2)).toEqual({ day: "2026-10-29", commits: 50, prs: 0 });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("splits the window when a search has more than GitHub will page through", async () => {
    const asked: string[] = [];
    const search: GitHubSearch = async (kind, _login, from, to) => {
      asked.push(`${kind} ${from}..${to}`);
      if (kind === "prs") return { total: 0, stamps: [] };
      return from === "2026-10-01" && to === TODAY ? { total: 1500, stamps: [] } : { total: 1, stamps: [`${to}T09:00:00Z`] };
    };
    const activity = await readGitHubActivity("dogfan", search, TODAY);
    expect(asked.slice(0, 3)).toEqual(["commits 2026-10-01..2026-10-30", "commits 2026-10-01..2026-10-15", "commits 2026-10-16..2026-10-30"]);
    if (activity.state !== "ready") throw new Error("not ready");
    expect(activity.days.find((day) => day.day === "2026-10-15")!.commits).toBe(1);
    expect(activity.days.at(-1)!.commits).toBe(1);
  });

  it("says signed out, without searching, when there is no GitHub login", async () => {
    const search = vi.fn<GitHubSearch>();
    expect(await readGitHubActivity(null, search, TODAY)).toEqual({ state: "signedOut" });
    expect(search).not.toHaveBeenCalled();
  });

  it("treats a missing or signed-out gh as no login", async () => {
    const missing: CommandRunner = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
    const signedOut: CommandRunner = async () => ({ stdout: "", stderr: "gh auth login", exitCode: 4, timedOut: false });
    const signedIn: CommandRunner = async () => ({ stdout: "dogfan\n", stderr: "", exitCode: 0, timedOut: false });
    expect(await ghLogin(missing)).toBeNull();
    expect(await ghLogin(signedOut)).toBeNull();
    expect(await ghLogin(signedIn)).toBe("dogfan");
  });

  it("asks GitHub's search for the login's commits and PRs in the window", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_binary, args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ total_count: 1, items: [{ commit: { author: { date: "2026-10-30T01:00:00Z" } }, created_at: "2026-10-29T01:00:00Z" }] }), stderr: "", exitCode: 0, timedOut: false };
    };
    const search = ghSearch(run);
    expect(await search("commits", "dogfan", "2026-10-01", TODAY, 1)).toEqual({ total: 1, stamps: ["2026-10-30T01:00:00Z"] });
    expect(await search("prs", "dogfan", "2026-10-01", TODAY, 2)).toEqual({ total: 1, stamps: ["2026-10-29T01:00:00Z"] });
    expect(calls[0]).toContain("search/commits");
    expect(calls[0]).toContain("q=author:dogfan author-date:2026-10-01..2026-10-30");
    expect(calls[1]).toContain("search/issues");
    expect(calls[1]).toContain("q=author:dogfan type:pr created:2026-10-01..2026-10-30");
    expect(calls[1]).toContain("page=2");
  });

  it("keeps an answer for ten minutes and asks again after", async () => {
    let now = Date.parse(`${TODAY}T12:00:00Z`);
    const search = vi.fn<GitHubSearch>(async () => ({ total: 0, stamps: [] }));
    const activity = createGitHubActivity({ login: async () => "dogfan", search, now: () => now, pauseMs: 0 });
    await activity.read();
    now += 9 * 60_000;
    await activity.read();
    expect(search).toHaveBeenCalledTimes(2);
    now += 2 * 60_000;
    await activity.read();
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("reports GitHub failing as unavailable instead of throwing", async () => {
    const activity = createGitHubActivity({ login: async () => "dogfan", search: async () => { throw new Error("API rate limit exceeded"); }, pauseMs: 0 });
    expect(await activity.read()).toEqual({ state: "unavailable", message: "API rate limit exceeded" });
  });

  it("keeps showing today's last answer while GitHub refuses, and tries again sooner", async () => {
    let now = Date.parse(`${TODAY}T12:00:00Z`);
    let refuse = false;
    const search = vi.fn<GitHubSearch>(async () => {
      if (refuse) throw new Error("secondary rate limit");
      return { total: 1, stamps: [`${TODAY}T10:00:00Z`] };
    });
    const activity = createGitHubActivity({ login: async () => "dogfan", search, now: () => now, pauseMs: 0 });
    const first = await activity.read();
    refuse = true;
    now += 11 * 60_000;
    expect(await activity.read()).toEqual(first);
    const asked = search.mock.calls.length;
    now += 4 * 60_000;
    await activity.read();
    expect(search.mock.calls.length).toBe(asked);
    now += 2 * 60_000;
    await activity.read();
    expect(search.mock.calls.length).toBeGreaterThan(asked);
  });

  it("waits between search requests so GitHub does not see a burst", async () => {
    vi.useFakeTimers();
    try {
      const search = vi.fn<GitHubSearch>(async () => ({ total: 0, stamps: [] }));
      const reading = readGitHubActivity("dogfan", search, TODAY, 1500);
      await vi.advanceTimersByTimeAsync(0);
      expect(search).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1499);
      expect(search).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(search).toHaveBeenCalledTimes(2);
      await reading;
    } finally {
      vi.useRealTimers();
    }
  });
});
