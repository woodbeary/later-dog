import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  fetchGithubTeam,
  fetchLibraryTeam,
  fetchTeamCatalog,
  githubManifestUrls,
  parseTeamCatalog,
  teamLibraryRawRoot,
  teamLibraryRepository,
} from "./team-library.ts";

// No library is built in; these tests name one the way a deployment would.
const REPOSITORY = "https://github.com/example/teams";
const RAW_ROOT = teamLibraryRawRoot(REPOSITORY);

const manifest = {
  format: "laterdog.team",
  version: 2,
  team: {
    name: "Engineering",
    members: [
      {
        key: "lead",
        name: "Ada",
        title: "Tech Lead",
        description: "Coordinates the work",
        appearance: { color: "purple" },
      },
    ],
  },
};

const catalog = {
  format: "laterdog.catalog",
  version: 1,
  teams: [
    {
      slug: "engineering",
      name: "Engineering Team",
      summary: "Plan and ship software.",
      category: "Engineering",
      manifest: "teams/engineering/team.dogteam.json",
      readme: "teams/engineering/README.md",
      members: 1,
      skills: ["teams/engineering/skills/release/SKILL.md"],
      requires: { apps: ["GitHub"] },
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("team library", () => {
  it("is configured only by the deployment, as a public GitHub repository, and says so when it is not", async () => {
    expect(teamLibraryRepository({})).toBeNull();
    expect(teamLibraryRepository({ LATERDOG_TEAM_LIBRARY_REPOSITORY: " https://github.com/example/teams.git/ " })).toBe(REPOSITORY);
    expect(teamLibraryRepository({ LATERDOG_TEAM_LIBRARY_REPOSITORY: "https://github.com/example/teams" })).toBe(REPOSITORY);
    expect(() => teamLibraryRepository({ LATERDOG_TEAM_LIBRARY_REPOSITORY: "https://example.com/teams" })).toThrow("public GitHub repository");
    expect(RAW_ROOT).toBe("https://raw.githubusercontent.com/example/teams/main");
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(fetchTeamCatalog(fetcher, null)).rejects.toThrow("No community template library is configured");
    await expect(fetchLibraryTeam("engineering", fetcher, null)).rejects.toThrow("No community template library is configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates catalog paths and adds the trusted repository URL", () => {
    const parsed = parseTeamCatalog(catalog, REPOSITORY);
    expect(parsed.repositoryUrl).toBe(REPOSITORY);
    expect(parsed.teams[0]).toMatchObject({ slug: "engineering", members: 1 });

    const unsafe = structuredClone(catalog);
    unsafe.teams[0]!.manifest = "../private.json";
    expect(() => parseTeamCatalog(unsafe, REPOSITORY)).toThrow("safe catalog path");
  });

  it("loads only the manifest selected by the trusted catalog", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === `${RAW_ROOT}/catalog.json`) return response(catalog);
      if (target === `${RAW_ROOT}/teams/engineering/team.dogteam.json`) return response(manifest);
      return response({}, 404);
    }) as unknown as typeof fetch;

    const loaded = await fetchLibraryTeam("engineering", fetcher, REPOSITORY);
    if (loaded.format !== "laterdog.team") throw new Error("expected a legacy team");
    expect(loaded.team.name).toBe("Engineering");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes public GitHub repository, blob, and raw links", () => {
    expect(githubManifestUrls("https://github.com/acme/team")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/main/team.md",
      "https://raw.githubusercontent.com/acme/team/main/team.dogteam.json",
      "https://raw.githubusercontent.com/acme/team/master/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/master/team.md",
      "https://raw.githubusercontent.com/acme/team/master/team.dogteam.json",
    ]);
    expect(githubManifestUrls("https://github.com/acme/team/blob/main/presets/seo.dogteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/presets/seo.dogteam.json",
    ]);
    expect(githubManifestUrls("https://raw.githubusercontent.com/acme/team/main/team.dogteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/team.dogteam.json",
    ]);
    expect(() => githubManifestUrls("http://example.com/team.json")).toThrow("public HTTPS GitHub");
    expect(() => githubManifestUrls("https://github.com/acme/team/blob/main/run.sh")).toThrow("Markdown playbook");
  });

  it("falls back from main to master for a repository link", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("team.dogteam.json") && String(url).includes("/master/")
        ? response(manifest)
        : response({}, 404),
    ) as unknown as typeof fetch;

    const loaded = await fetchGithubTeam("https://github.com/acme/team", fetcher);
    if (loaded.format !== "laterdog.team") throw new Error("expected a legacy team");
    expect(loaded.team.members[0]?.name).toBe("Ada");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("loads a shared team file (package v2) from GitHub as a file, without its claimed publisher", async () => {
    const shared = JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
    const fetcher = vi.fn(async () => response(shared)) as unknown as typeof fetch;
    const loaded = await fetchGithubTeam("https://github.com/acme/team/blob/main/sales-desk-1.3.0.laterdog.json", fetcher);
    if (loaded.format !== "laterdog.package" || loaded.version !== 2) throw new Error("expected a shared team");
    expect(loaded.package.team?.name).toBe("Sales desk");
    expect(loaded.package.publisher).toBeUndefined();
  });
});
