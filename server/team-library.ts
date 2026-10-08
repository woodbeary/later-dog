import { parseJson, type JsonValue } from "./schema.ts";
import { isBotPackage, parseBotPackage, parsePackageDocument, type PackageDocument, type ParsedBotPackage } from "./bot-package.ts";
import { parseTeamManifest, type ParsedTeamManifest } from "./team-manifest.ts";

/** The public GitHub repository that publishes the community template
 * catalog (a catalog.json at the root of its main branch). None is built in:
 * a deployment names its own with LATERDOG_TEAM_LIBRARY_REPOSITORY; unset, the Templates shelf says so. */
export function teamLibraryRepository(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env.LATERDOG_TEAM_LIBRARY_REPOSITORY ?? "").trim();
  if (!value) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match) throw new Error("LATERDOG_TEAM_LIBRARY_REPOSITORY must be a public GitHub repository address (https://github.com/<owner>/<repo>)");
  return `https://github.com/${match[1]}/${match[2]}`;
}

/** Where that repository's files are read from. */
export function teamLibraryRawRoot(repository: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(repository);
  if (!match) throw new Error("The pack library repository address is invalid");
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main`;
}

const NOT_CONFIGURED = "No community template library is configured on this server. Set LATERDOG_TEAM_LIBRARY_REPOSITORY to a public GitHub repository that publishes a catalog.json.";

const MAX_CATALOG_BYTES = 256_000;
const MAX_MANIFEST_BYTES = 1_000_000;

export interface TeamCatalogEntry {
  slug: string;
  name: string;
  summary: string;
  category: string;
  outcome?: string;
  setupMinutes?: number;
  featured?: boolean;
  package?: string;
  manifest: string;
  readme: string;
  members: number;
  skills: string[];
  requires: { apps: string[] };
}

export interface TeamCatalog {
  format: "laterdog.catalog";
  version: 1;
  repositoryUrl: string;
  teams: TeamCatalogEntry[];
}

type Fetcher = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function relativeFile(value: unknown, field: string, suffix: string, prefix: string): string {
  const path = text(value, field, 300);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !path.startsWith(prefix) ||
    !path.endsWith(suffix)
  ) {
    throw new Error(`${field} is not a safe catalog path`);
  }
  return path;
}

function stringList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} is invalid`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 100));
}

/** Validate the remotely maintained index before any of it reaches the renderer. */
export function parseTeamCatalog(value: unknown, repositoryUrl: string): TeamCatalog {
  if (!isRecord(value) || value.format !== "laterdog.catalog" || value.version !== 1) {
    throw new Error("The pack library catalog is not supported");
  }
  if (!Array.isArray(value.teams) || value.teams.length > 100) {
    throw new Error("The pack library catalog is invalid");
  }
  const slugs = new Set<string>();
  const teams = value.teams.map((raw, index): TeamCatalogEntry => {
    const field = `teams[${index}]`;
    if (!isRecord(raw)) throw new Error(`${field} is invalid`);
    const slug = text(raw.slug, `${field}.slug`, 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slugs.has(slug)) {
      throw new Error(`${field}.slug is invalid`);
    }
    slugs.add(slug);
    const prefix = `teams/${slug}/`;
    const requires = isRecord(raw.requires) ? raw.requires : {};
    return {
      slug,
      name: text(raw.name, `${field}.name`, 100),
      summary: text(raw.summary, `${field}.summary`, 300),
      category: text(raw.category, `${field}.category`, 80),
      ...(typeof raw.outcome === "string" ? { outcome: text(raw.outcome, `${field}.outcome`, 300) } : {}),
      ...(typeof raw.setupMinutes === "number" && Number.isSafeInteger(raw.setupMinutes) && raw.setupMinutes > 0 && raw.setupMinutes <= 240
        ? { setupMinutes: raw.setupMinutes }
        : {}),
      ...(typeof raw.featured === "boolean" ? { featured: raw.featured } : {}),
      ...(raw.package !== undefined
        ? { package: relativeFile(raw.package, `${field}.package`, ".md", "packages/") }
        : {}),
      manifest: relativeFile(raw.manifest, `${field}.manifest`, ".dogteam.json", prefix),
      readme: relativeFile(raw.readme, `${field}.readme`, "README.md", prefix),
      members:
        typeof raw.members === "number" && Number.isSafeInteger(raw.members) && raw.members > 0 && raw.members <= 200
          ? raw.members
          : (() => { throw new Error(`${field}.members is invalid`); })(),
      skills: Array.isArray(raw.skills)
        ? raw.skills.map((skill, skillIndex) =>
            relativeFile(skill, `${field}.skills[${skillIndex}]`, "SKILL.md", `${prefix}skills/`),
          )
        : (() => { throw new Error(`${field}.skills is invalid`); })(),
      requires: { apps: stringList(requires.apps ?? [], `${field}.requires.apps`, 30) },
    };
  });
  return {
    format: "laterdog.catalog",
    version: 1,
    repositoryUrl,
    teams,
  };
}

async function fetchJson(url: string, maxBytes: number, fetcher: Fetcher): Promise<JsonValue> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
    throw error;
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote pack file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote pack file is too large");
  try {
    return parseJson(raw);
  } catch {
    throw new Error("GitHub did not return valid JSON");
  }
}

async function fetchText(url: string, maxBytes: number, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "text/markdown, text/plain;q=0.9" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub returned HTTP ${response.status}`), { status: response.status });
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > maxBytes) throw new Error("The remote pack file is too large");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error("The remote pack file is too large");
  return raw;
}

export async function fetchTeamCatalog(fetcher: Fetcher = fetch, repository: string | null = teamLibraryRepository()): Promise<TeamCatalog> {
  if (!repository) throw new Error(NOT_CONFIGURED);
  return parseTeamCatalog(await fetchJson(`${teamLibraryRawRoot(repository)}/catalog.json`, MAX_CATALOG_BYTES, fetcher), repository);
}

export type ParsedShareableTeam = ParsedTeamManifest | ParsedBotPackage | PackageDocument;

function parseShareable(value: JsonValue | string): ParsedShareableTeam {
  if (typeof value === "string") return parseBotPackage(value);
  if (!isBotPackage(value)) return parseTeamManifest(value);
  // A shared team (v2) is read as a file: it cannot claim a publisher.
  // Version 1 keeps its original shape for older callers.
  return (value as { version?: unknown }).version === 1 ? parseBotPackage(value) : parsePackageDocument(value, { trust: "file" });
}

async function fetchShareable(url: string, fetcher: Fetcher): Promise<ParsedShareableTeam> {
  return url.endsWith(".md")
    ? parseBotPackage(await fetchText(url, MAX_MANIFEST_BYTES, fetcher))
    : parseShareable(await fetchJson(url, MAX_MANIFEST_BYTES, fetcher));
}

export async function fetchLibraryTeam(slug: string, fetcher: Fetcher = fetch, repository: string | null = teamLibraryRepository()): Promise<ParsedShareableTeam> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("That pack name is invalid");
  if (!repository) throw new Error(NOT_CONFIGURED);
  const catalog = await fetchTeamCatalog(fetcher, repository);
  const entry = catalog.teams.find((team) => team.slug === slug);
  if (!entry) throw Object.assign(new Error("That library pack was not found"), { status: 404 });
  return fetchShareable(`${teamLibraryRawRoot(repository)}/${entry.package ?? entry.manifest}`, fetcher);
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** Resolve only public GitHub Markdown playbooks and legacy JSON team files.
 * Other hosts never reach server fetch. */
export function githubManifestUrls(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS GitHub links are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.every(safeSegment)) throw new Error("That GitHub path is not supported");

  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    if (parts.length === 2) {
      const [owner, repo] = parts;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/team.dogteam.json`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/botmrr.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/team.dogteam.json`,
      ];
    }
    if (parts.length >= 5 && (parts[2] === "blob" || parts[2] === "raw")) {
      const [owner, repo, , ref, ...file] = parts;
      if (!file.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON pack file");
      return [`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}`];
    }
  }

  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    if (!parts.at(-1)?.match(/\.(?:md|json)$/)) throw new Error("The GitHub link must point to a Markdown playbook or JSON pack file");
    return [`https://raw.githubusercontent.com/${parts.join("/")}`];
  }

  throw new Error("Paste a GitHub repository, Markdown playbook, or legacy JSON pack link");
}

export async function fetchGithubTeam(input: string, fetcher: Fetcher = fetch): Promise<ParsedShareableTeam> {
  const urls = githubManifestUrls(input);
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchShareable(url, fetcher);
    } catch (error) {
      lastError = error;
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  throw lastError ?? new Error("No botmrr.md, team.md, or legacy pack file was found in that repository");
}
