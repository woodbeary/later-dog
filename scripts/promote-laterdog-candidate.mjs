import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fileDigest } from "./laterdog-release-files.mjs";
import { CANDIDATE_ARTIFACT, RELEASE_ASSETS, verifyAcceptance, verifyCandidate } from "./laterdog-release-candidate.mjs";
import { githubApi, waitForReleaseCi } from "./release-ci.mjs";
import { verifyReleaseAuthority } from "./release-authority.mjs";
import { CLOUD_IMAGE_ARTIFACT } from "./cloud-image-receipt.mjs";
import { easBuildSource } from "./eas-build-source.mjs";

export async function promoteCandidate({ candidate, evidence, directory, evidenceDirectory = directory, api, publish = false, log = console.log }) {
  verifyCandidate(directory, candidate);
  verifyAcceptance(candidate, evidence);
  const build = await api.build(candidate.runId);
  if (build.head_sha !== candidate.sha || build.status !== "completed" || build.conclusion !== "success" || build.path !== ".github/workflows/macos.yml") throw new Error("Candidate build is not the successful pinned macOS workflow run.");
  await verifyReleaseAuthority({ candidate, evidence, api: api.authority, directory: evidenceDirectory });
  const ci = await waitForReleaseCi({ api: api.ci, sha: candidate.sha, log });
  if (!ci.ok) throw new Error(ci.reason);
  const existing = await api.release(candidate.tag);
  const latest = await api.latest();
  const versionParts = value => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "")?.slice(1).map(Number);
  const candidateVersion = versionParts(candidate.version);
  const latestVersion = versionParts(latest?.tag_name);
  if (latestVersion) {
    const difference = latestVersion.map((part, index) => part - candidateVersion[index]).find(value => value !== 0);
    if (difference > 0) throw new Error("A newer stable release is already available; publish a higher repair version instead.");
  }
  if (existing && existing.target_commitish !== candidate.sha && await api.tagSha(candidate.tag) !== candidate.sha) throw new Error("Existing release targets another commit.");
  if (!publish) return { status: "verified", tag: candidate.tag, sha: candidate.sha, ciRunId: ci.runId };
  const tagSha = await api.tagSha(candidate.tag);
  if (tagSha && tagSha !== candidate.sha) throw new Error("Release tag already points to another commit.");
  if (!existing) await api.createDraft(candidate, directory);
  const release = await api.release(candidate.tag);
  if (!release || (release.target_commitish !== candidate.sha && await api.tagSha(candidate.tag) !== candidate.sha)) throw new Error("Draft release source could not be verified.");
  for (const name of RELEASE_ASSETS) {
    const present = release.assets.some(asset => asset.name === name);
    if (!present) {
      if (!release.draft) throw new Error(`Published release is missing ${name}; refusing replacement.`);
      await api.upload(candidate.tag, join(directory, name));
    }
    const bytes = await api.download(candidate.tag, name);
    if (fileDigest(bytes).sha256 !== candidate.files[name].sha256) throw new Error(`Release asset differs from the accepted candidate: ${name}`);
  }
  if (release.draft) await api.publish(candidate.tag);
  const final = await api.release(candidate.tag);
  if (!final || final.draft || final.prerelease || await api.tagSha(candidate.tag) !== candidate.sha || (await api.latest())?.id !== final.id) throw new Error("Public Latest release state could not be verified.");
  return { status: "published", tag: candidate.tag, sha: candidate.sha, ciRunId: ci.runId, url: final.html_url };
}

async function main() {
  const { values } = parseArgs({ options: { "run-id": { type: "string" }, evidence: { type: "string" }, "phone-directory": { type: "string" }, repository: { type: "string", default: "woodbeary/later-dog" }, publish: { type: "boolean", default: false } } });
  if (!/^[1-9]\d*$/.test(values["run-id"] ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(values.repository) || !values.evidence || !values["phone-directory"]) throw new Error("Pass --run-id, --evidence and --phone-directory; --publish promotes only after all checks pass.");
  const evidence = JSON.parse(readFileSync(resolve(values.evidence), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "laterdog-promote-"));
  const repository = values.repository;
  const gh = args => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const get = path => JSON.parse(gh(["api", `repos/${repository}/${path}`]));
  const optional = path => {
    try { return get(path); } catch (error) {
      if (String(error.stderr ?? "").includes("HTTP 404")) return null;
      throw error;
    }
  };
  try {
    gh(["run", "download", values["run-id"], "--repo", repository, "--name", CANDIDATE_ARTIFACT, "--dir", root]);
    const candidate = verifyCandidate(root, JSON.parse(readFileSync(join(root, "candidate.json"), "utf8")));
    if (candidate.repository !== repository || candidate.runId !== values["run-id"]) throw new Error("Downloaded candidate belongs to another repository or run.");
    const current = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (current !== candidate.sha) throw new Error("Run promotion from the candidate source commit so its CI contract matches.");
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || gh(["auth", "token"]).trim();
    const api = {
      ci: githubApi({ token, repository }),
      build: id => get(`actions/runs/${id}`),
      release: tag => optional(`releases/tags/${encodeURIComponent(tag)}`),
      latest: () => optional("releases/latest"),
      tagSha: tag => {
        let object = optional(`git/ref/tags/${encodeURIComponent(tag)}`)?.object;
        for (let depth = 0; object?.type === "tag" && depth < 5; depth++) object = get(`git/tags/${object.sha}`).object;
        return object?.type === "commit" ? object.sha : null;
      },
      createDraft: (candidate, directory) => gh(["release", "create", candidate.tag, "--repo", repository, "--draft", "--target", candidate.sha, "--title", `later.dog ${candidate.tag}`, "--notes-file", join(directory, "NOTES.md")]),
      upload: (tag, file) => gh(["release", "upload", tag, file, "--repo", repository]),
      download: (tag, name) => {
        const directory = mkdtempSync(join(root, "asset-"));
        gh(["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", directory]);
        return readFileSync(join(directory, name));
      },
      publish: tag => gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--prerelease=false", "--latest"]),
      authority: {
        source: (source, sha) => ({
          pull: JSON.parse(gh(["api", `repos/${source.repository}/pulls/${source.prNumber}`])),
          comparison: JSON.parse(gh(["api", `repos/${source.repository}/compare/${sha}...main`])),
        }),
        review: async review => {
          const { callTool } = await import("../server/laterdog/mcp.ts");
          if (review.kind === "supervisor-standalone") return {
            reviewer: await callTool("inspect_cloud_job", { jobId: review.jobId }),
            patch: await callTool("collect_cloud_diff", { jobId: review.jobId }),
          };
          return {
            parent: await callTool("inspect_cloud_job", { jobId: review.jobId }),
            reviewer: await callTool("inspect_cloud_job", { jobId: review.reviewerJobId }),
            patch: await callTool("collect_cloud_diff", { jobId: review.reviewerJobId }),
          };
        },
        reviewSource: (repository, baseSha, sha, sourceRef) => ({
          input: JSON.parse(gh(["api", `repos/${repository}/commits/${encodeURIComponent(sourceRef)}`])),
          comparison: JSON.parse(gh(["api", `repos/${repository}/compare/${baseSha}...${sha}`])),
        }),
        phone: async phone => {
          const phoneDirectory = resolve(values["phone-directory"]);
          const run = (binary, args, cwd) => execFileSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
          const easBinary = process.env.LATERDOG_EAS_CLI ?? "eas";
          const version = /eas-cli\/(\d+)\./.exec(run(easBinary, ["--version"], phoneDirectory));
          if (!version || Number(version[1]) < 24) throw new Error("Release verification requires EAS CLI 24 or newer.");
          if (run("git", ["rev-parse", "HEAD"], phoneDirectory).trim() !== phone.sourceSha || run("git", ["status", "--porcelain"], phoneDirectory).trim()) throw new Error("Use a clean phone checkout at the accepted source SHA for release verification.");
          const asc = args => JSON.parse(run("asc", [...args, "--build-id", phone.ascBuildId, "--output", "json"]));
          const cliPath = run("which", [easBinary], phoneDirectory).trim();
          const cleanSource = await easBuildSource(cliPath, phone.easBuildId);
          return {
            build: asc(["builds", "info"]), app: asc(["builds", "app", "view"]),
            version: asc(["builds", "pre-release-version", "view"]), beta: asc(["builds", "build-beta-detail", "view"]),
            eas: { ...JSON.parse(run(easBinary, ["build:view", phone.easBuildId, "--json"], phoneDirectory)), isGitWorkingTreeDirty: cleanSource.isGitWorkingTreeDirty },
          };
        },
        cloud: cloud => {
          const directory = mkdtempSync(join(root, "cloud-"));
          gh(["run", "download", String(cloud.buildRunId), "--repo", repository, "--name", CLOUD_IMAGE_ARTIFACT, "--dir", directory]);
          const source = get(`contents/Dockerfile?ref=${cloud.sourceSha}`);
          if (source.encoding !== "base64") throw new Error("Cloud source Dockerfile could not be read.");
          return { run: get(`actions/runs/${cloud.buildRunId}`), receiptBytes: readFileSync(join(directory, "cloud-image.json")), dockerfile: Buffer.from(source.content, "base64").toString("utf8") };
        },
      },
    };
    console.log(JSON.stringify(await promoteCandidate({ candidate, evidence, directory: root, evidenceDirectory: dirname(resolve(values.evidence)), api, publish: values.publish }), null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
