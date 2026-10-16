import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { ACCEPTANCE_CHECKS, candidateManifest, CLOUD_ACCEPTANCE_CHECKS, PHONE_IDENTITY_FIELDS, RELEASE_ASSETS, verifyAcceptance, verifyCandidate } from "./laterdog-release-candidate.mjs";
import { promoteCandidate } from "./promote-laterdog-candidate.mjs";
import { releaseFiles } from "./laterdog-release-files.mjs";
import { cloudImageReceipt } from "./cloud-image-receipt.mjs";
import { PHONE_APP_ID, PHONE_BUNDLE_ID, PHONE_PROJECT_ID, verifyReleaseAuthority } from "./release-authority.mjs";

const roots = [];
const hash = value => createHash("sha256").update(value).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "laterdog-candidate-test-"));
  roots.push(directory);
  const zip = Buffer.from("accepted zip bytes");
  const dmg = Buffer.from("accepted dmg bytes");
  writeFileSync(join(directory, RELEASE_ASSETS[0]), zip);
  writeFileSync(join(directory, RELEASE_ASSETS[1]), dmg);
  const files = releaseFiles({ tag: "v0.4.0", packageVersion: "0.4.0", changelog: "## 0.4.0 — 2026-10-16\nNative activity", zipName: RELEASE_ASSETS[0], zipBytes: zip, diskImageName: RELEASE_ASSETS[1], diskImageBytes: dmg, repository: "o/r", releaseDate: "2026-10-16T00:00:00Z", notarized: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  const input = { directory, tag: "v0.4.0", version: "0.4.0", sha: "a".repeat(40), repository: "o/r", runId: "7", identity: "Developer ID Application: Example (ABCDEFGHIJ)", appNotary: { status: "Accepted", id: "app-ticket" }, dmgNotary: { status: "Accepted", id: "dmg-ticket" } };
  const candidate = candidateManifest(input);
  const phone = { sourceSha: "b".repeat(40), appVersion: "1.0.2", runtimeVersion: "1.0.2", buildNumber: "7", ascBuildId: "12142a10-ec18-4da8-9d84-e37f8ae0863e", easBuildId: "82e99cb4-2dea-45a0-a2a5-b194130df0bc" };
  const providerVersions = { claude: "2.1.301", codex: "0.163.0" };
  const cloud = { sourceSha: "d".repeat(40), imageDigest: `sha256:${"e".repeat(64)}`, providerVersions: { ...providerVersions } };
  const checks = Object.fromEntries(ACCEPTANCE_CHECKS.map(name => [name, { status: "pass", evidence: `fixture evidence for ${name}`, sourceSha: name === "expo-development" ? phone.sourceSha : name === "cloud-test-home" ? cloud.sourceSha : candidate.sha }]));
  for (const name of CLOUD_ACCEPTANCE_CHECKS) checks[name].cloud = structuredClone(cloud);
  Object.assign(checks["cloud-test-home"], { environment: "staged", homeId: "fixture-staged-home" });
  Object.assign(checks["expo-development"], { appVersion: phone.appVersion, runtimeVersion: phone.runtimeVersion });
  for (const name of ["exact-testflight-build", "real-iphone", "desktop-mobile-compatibility"]) checks[name].phone = { ...phone };
  checks["real-iphone"].deviceType = "physical";
  for (const name of ["real-account-conversation", "workspace-identity", "independent-review"]) checks[name].phoneSourceSha = phone.sourceSha;
  checks["independent-review"].cloudSourceSha = cloud.sourceSha;
  for (const provider of ["claude", "codex"]) checks[`native-${provider}`].providerVersion = providerVersions[provider];
  const evidence = { schemaVersion: 3, sourceSha: candidate.sha, version: candidate.version, candidateRunId: candidate.runId, assets: Object.fromEntries(RELEASE_ASSETS.slice(0, 2).map(name => [name, candidate.files[name].sha256])), phone, cloud, providerVersions, checks };
  const observation = "Fixture-only acceptance observation; no live account or build was tested.";
  writeFileSync(join(directory, "observation.txt"), observation);
  for (const name of ACCEPTANCE_CHECKS.filter(name => name !== "independent-review")) {
    const receipt = JSON.stringify({ schemaVersion: 1, check: name, status: "pass", sourceSha: checks[name].sourceSha, candidateRunId: candidate.runId, desktopZipSha256: candidate.files[RELEASE_ASSETS[0]].sha256, phoneSourceSha: phone.sourceSha, ascBuildId: phone.ascBuildId, cloudImageDigest: cloud.imageDigest, observations: [observation], artifacts: [{ path: "observation.txt", sha256: hash(observation) }] });
    writeFileSync(join(directory, `${name}.json`), receipt);
    checks[name].receipt = { path: `${name}.json`, sha256: hash(receipt) };
  }
  evidence.sources = Object.fromEntries(["desktop", "phone", "cloud"].map((name, index) => [name, { repository: name === "phone" ? "o/phone" : candidate.repository, prNumber: index + 1 }]));
  const sources = { desktop: candidate.sha, phone: phone.sourceSha, cloud: cloud.sourceSha };
  const reviews = Object.fromEntries(Object.entries(sources).map(([name, sha]) => {
    const source = evidence.sources[name];
    const report = { headSha: sha, verdict: "pass", summary: "Checked fixture behavior and release boundaries." };
    const patch = `diff --git a/.laterdog-review.json b/.laterdog-review.json\nnew file mode 100644\n--- /dev/null\n+++ b/.laterdog-review.json\n@@ -0,0 +1 @@\n+${JSON.stringify(report)}\n`;
    const jobId = `job-${name}`;
    const reviewerJobId = `review-${name}`;
    return [name, { parent: { job: { id: jobId, repository: source.repository, prNumber: source.prNumber, headSha: sha, taskId: `task-${name}`, review: { ...report, reviewerJobId } } }, reviewer: { job: { id: reviewerJobId, kind: "review", parentId: jobId, repository: source.repository, baseSha: sha, state: "ready", taskId: `independent-task-${name}` } }, patch: { patch } }];
  }));
  evidence.reviews = Object.fromEntries(Object.entries(reviews).map(([name, result]) => [name, { jobId: result.parent.job.id, reviewerJobId: result.reviewer.job.id, patchSha256: hash(result.patch.patch) }]));
  cloud.buildRunId = "8";
  const cloudBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sourceSha: cloud.sourceSha, repository: candidate.repository, runId: cloud.buildRunId, imageDigest: cloud.imageDigest, providerVersions }));
  cloud.receiptSha256 = hash(cloudBytes);
  const phoneRecord = { build: { data: { id: phone.ascBuildId, attributes: { version: phone.buildNumber, processingState: "VALID", expired: false } } }, app: { data: { id: PHONE_APP_ID, attributes: { bundleId: PHONE_BUNDLE_ID } } }, version: { data: { attributes: { version: phone.appVersion, platform: "IOS" } } }, beta: { data: { attributes: { externalBuildState: "IN_BETA_TESTING" } } }, eas: { id: phone.easBuildId, project: { id: PHONE_PROJECT_ID }, status: "FINISHED", platform: "IOS", distribution: "STORE", buildProfile: "beta", channel: "beta", isGitWorkingTreeDirty: false, gitCommitHash: phone.sourceSha, appVersion: phone.appVersion, appBuildVersion: phone.buildNumber, runtimeVersion: phone.runtimeVersion } };
  const dockerfile = 'ARG CLOUD_HOME_ENGINES="@anthropic-ai/claude-code@2.1.301 @openai/codex@0.163.0"';
  let release = null;
  let latest = { id: 1, tag_name: "v0.3.33" };
  const uploaded = new Map();
  const calls = [];
  const api = {
    build: async () => ({ head_sha: candidate.sha, status: "completed", conclusion: "success", path: ".github/workflows/macos.yml" }),
    ci: { runsForCommit: async () => [{ id: 9, head_sha: candidate.sha, status: "completed", conclusion: "success", event: "push", created_at: "2026-10-16T00:00:00Z" }], gateConclusion: async () => "success" },
    release: async () => release,
    latest: async () => latest,
    tagSha: async () => release && !release.draft ? candidate.sha : null,
    createDraft: async () => { calls.push("draft"); release = { id: 2, draft: true, prerelease: false, target_commitish: candidate.sha, tag_name: candidate.tag, assets: [], html_url: "https://example.test/release" }; },
    upload: async (_tag, path) => { const name = basename(path); calls.push(`upload ${name}`); uploaded.set(name, readFileSync(path)); release.assets.push({ name }); },
    download: async (_tag, name) => uploaded.get(name),
    publish: async () => { calls.push("publish"); release.draft = false; latest = release; },
    authority: {
      source: async (source, sha) => ({ pull: { merged: true, base: { ref: "main", repo: { full_name: source.repository } }, head: { sha } }, comparison: { merge_base_commit: { sha } } }),
      review: async review => reviews[review.jobId.slice("job-".length)],
      phone: async () => phoneRecord,
      cloud: async () => ({ run: { head_sha: cloud.sourceSha, path: ".github/workflows/cloud-home-image.yml", status: "completed", conclusion: "success" }, receiptBytes: cloudBytes, dockerfile }),
    },
  };
  return { directory, input, candidate, evidence, api, calls, uploaded, reviews, phoneRecord, dockerfile };
}

describe("release candidates", () => {
  it("requires Developer ID and accepted notarization for both app and disk image", () => {
    const f = fixture();
    expect(verifyCandidate(f.directory, f.candidate)).toBe(f.candidate);
    for (const patch of [{ identity: "later.dog Developer" }, { appNotary: { status: "Invalid", id: "app" } }, { dmgNotary: null }, { tag: "v0.4.0-preview.1" }]) expect(() => candidateManifest({ ...f.input, ...patch })).toThrow();
  });

  it("binds QA to the exact source, binaries, review and real-device evidence", () => {
    const f = fixture();
    expect(verifyAcceptance(f.candidate, f.evidence)).toBe(f.evidence);
    expect(() => verifyAcceptance(f.candidate, { ...f.evidence, sourceSha: "b".repeat(40) })).toThrow("does not match");
    expect(() => verifyAcceptance(f.candidate, { ...f.evidence, assets: {} })).toThrow("these bytes");
    for (const check of ACCEPTANCE_CHECKS) expect(() => verifyAcceptance(f.candidate, { ...f.evidence, checks: { ...f.evidence.checks, [check]: { status: "blocked", evidence: "not verified" } } })).toThrow("acceptance");
    writeFileSync(join(f.directory, RELEASE_ASSETS[0]), "rebuilt bytes");
    expect(() => verifyCandidate(f.directory, f.candidate)).toThrow("bytes changed");
  });

  it("rejects stale phone sources, builds, development runtimes and simulator evidence", () => {
    const { candidate, evidence } = fixture();
    for (const field of PHONE_IDENTITY_FIELDS) {
      const missing = structuredClone(evidence);
      delete missing.phone[field];
      expect(() => verifyAcceptance(candidate, missing)).toThrow("frozen phone");
      for (const name of ["exact-testflight-build", "real-iphone", "desktop-mobile-compatibility"]) {
        const stale = structuredClone(evidence);
        stale.checks[name].phone[field] = "stale";
        expect(() => verifyAcceptance(candidate, stale)).toThrow("exact frozen phone build");
      }
    }
    for (const name of ["real-account-conversation", "workspace-identity", "independent-review"]) {
      const stale = structuredClone(evidence);
      stale.checks[name].phoneSourceSha = "c".repeat(40);
      expect(() => verifyAcceptance(candidate, stale)).toThrow("phone source commit");
    }
    const development = structuredClone(evidence);
    development.checks["expo-development"].runtimeVersion = "old-runtime";
    expect(() => verifyAcceptance(candidate, development)).toThrow("frozen phone app and runtime");
    const simulator = structuredClone(evidence);
    simulator.checks["real-iphone"].deviceType = "simulator";
    expect(() => verifyAcceptance(candidate, simulator)).toThrow("physical device");
  });

  it("requires exact provider versions and source-pinned receipts for every gate", () => {
    const { candidate, evidence } = fixture();
    for (const provider of ["claude", "codex"]) {
      const unpinned = structuredClone(evidence);
      unpinned.providerVersions[provider] = "latest";
      expect(() => verifyAcceptance(candidate, unpinned)).toThrow(`exact ${provider} version`);
      const stale = structuredClone(evidence);
      stale.checks[`native-${provider}`].providerVersion = "0.0.1";
      expect(() => verifyAcceptance(candidate, stale)).toThrow(`frozen ${provider} version`);
    }
    for (const name of ACCEPTANCE_CHECKS) {
      const stale = structuredClone(evidence);
      stale.checks[name].sourceSha = "c".repeat(40);
      expect(() => verifyAcceptance(candidate, stale)).toThrow("source commit");
    }
    expect(() => verifyAcceptance(candidate, { ...evidence, schemaVersion: 1 })).toThrow("does not match");
  });

  it("binds staged-home and app acceptance to one immutable Cloud image and its provider versions", () => {
    const { candidate, evidence } = fixture();
    for (const field of ["sourceSha", "imageDigest"]) {
      const missing = structuredClone(evidence);
      delete missing.cloud[field];
      expect(() => verifyAcceptance(candidate, missing)).toThrow("frozen Cloud source");
      for (const name of CLOUD_ACCEPTANCE_CHECKS) {
        const stale = structuredClone(evidence);
        stale.checks[name].cloud[field] = "stale";
        expect(() => verifyAcceptance(candidate, stale)).toThrow("frozen Cloud image");
      }
    }
    for (const provider of ["claude", "codex"]) {
      const changed = structuredClone(evidence);
      changed.cloud.providerVersions[provider] = "0.0.1";
      expect(() => verifyAcceptance(candidate, changed)).toThrow(`frozen ${provider} version`);
      const stale = structuredClone(evidence);
      stale.checks[`native-${provider}`].cloud.providerVersions[provider] = "0.0.1";
      expect(() => verifyAcceptance(candidate, stale)).toThrow("frozen Cloud image");
    }
    const review = structuredClone(evidence);
    review.checks["independent-review"].cloudSourceSha = "f".repeat(40);
    expect(() => verifyAcceptance(candidate, review)).toThrow("Cloud source commit");
    for (const patch of [{ homeId: "" }, { environment: "production" }]) {
      const unstaged = structuredClone(evidence);
      Object.assign(unstaged.checks["cloud-test-home"], patch);
      expect(() => verifyAcceptance(candidate, unstaged)).toThrow("staged test home");
    }
  });

  it("checks without publishing and promotes the same bytes only after every gate", async () => {
    const f = fixture();
    expect(await promoteCandidate({ ...f, log: () => {} })).toMatchObject({ status: "verified" });
    expect(f.calls).toEqual([]);
    expect(await promoteCandidate({ ...f, publish: true, log: () => {} })).toMatchObject({ status: "published" });
    expect(f.calls).toEqual(["draft", ...RELEASE_ASSETS.map(name => `upload ${name}`), "publish"]);
    expect(f.uploaded.get(RELEASE_ASSETS[0])).toEqual(readFileSync(join(f.directory, RELEASE_ASSETS[0])));
    await promoteCandidate({ ...f, publish: true, log: () => {} });
    expect(f.calls.filter(call => call === "publish")).toHaveLength(1);
  });

  it("leaves stable untouched when CI, artifact verification or version order fails", async () => {
    for (const failure of ["ci", "download", "newer", "build"]) {
      const f = fixture();
      if (failure === "ci") f.api.ci.gateConclusion = async () => "failure";
      if (failure === "download") f.api.download = async () => Buffer.from("wrong bytes");
      if (failure === "newer") f.api.latest = async () => ({ id: 8, tag_name: "v9.0.0" });
      if (failure === "build") f.api.build = async () => ({ head_sha: "b".repeat(40), status: "completed", conclusion: "success", path: ".github/workflows/macos.yml" });
      await expect(promoteCandidate({ ...f, publish: true, log: () => {} })).rejects.toThrow();
      expect(f.calls).not.toContain("publish");
    }
  });

  it("makes the workflow incapable of changing the public release during packaging", () => {
    const source = readFileSync(new URL("../.github/workflows/macos.yml", import.meta.url), "utf8");
    const workflow = parse(source);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.package.permissions).toBeUndefined();
    expect(source).not.toContain("gh release create");
    expect(source).toContain("MAC_DEVELOPER_ID_P12 MAC_DEVELOPER_ID_PASSWORD APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER");
    expect(source).toContain("node scripts/laterdog-release-candidate.mjs");
    expect(source).toContain("xcrun stapler validate out/later.dog-macOS-arm64.dmg");
  });

  it.each(["unmerged", "wrong-head", "not-on-main", "review-failed", "review-stale", "review-artifact", "review-same-task", "asc-invalid", "asc-wrong-app", "eas-stale", "eas-dirty", "eas-unknown", "cloud-artifact", "cloud-pins", "missing-proof", "changed-proof"])("refuses %s authoritative evidence before creating a draft", async failure => {
    const f = fixture();
    const source = f.api.authority.source;
    if (["unmerged", "wrong-head", "not-on-main"].includes(failure)) f.api.authority.source = async (...args) => {
      const result = await source(...args);
      if (failure === "unmerged") result.pull.merged = false;
      if (failure === "wrong-head") result.pull.head.sha = "f".repeat(40);
      if (failure === "not-on-main") result.comparison.merge_base_commit.sha = "f".repeat(40);
      return result;
    };
    if (failure === "review-failed") f.reviews.desktop.parent.job.review.verdict = "changes_requested";
    if (failure === "review-stale") f.reviews.desktop.reviewer.job.baseSha = "f".repeat(40);
    if (failure === "review-artifact") f.reviews.desktop.patch.patch += "changed";
    if (failure === "review-same-task") f.reviews.desktop.reviewer.job.taskId = f.reviews.desktop.parent.job.taskId;
    if (failure === "asc-invalid") f.phoneRecord.build.data.attributes.processingState = "PROCESSING";
    if (failure === "asc-wrong-app") f.phoneRecord.app.data.id = "another-app";
    if (failure === "eas-stale") f.phoneRecord.eas.gitCommitHash = "f".repeat(40);
    if (failure === "eas-dirty") f.phoneRecord.eas.isGitWorkingTreeDirty = true;
    if (failure === "eas-unknown") delete f.phoneRecord.eas.isGitWorkingTreeDirty;
    if (failure.startsWith("cloud-")) {
      const cloud = f.api.authority.cloud;
      f.api.authority.cloud = async () => ({ ...await cloud(), ...(failure === "cloud-artifact" ? { receiptBytes: Buffer.from("changed") } : { dockerfile: f.dockerfile.replace("0.163.0", "0.1.0") }) });
    }
    if (failure === "missing-proof") delete f.evidence.checks["real-iphone"].receipt;
    if (failure === "changed-proof") writeFileSync(join(f.directory, "observation.txt"), "changed");
    await expect(promoteCandidate({ ...f, publish: true, log: () => {} })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it("keeps a retained independent phone review distinct from supervisor-verified reviews", async () => {
    const f = fixture();
    const report = { headSha: f.evidence.phone.sourceSha, repository: f.evidence.sources.phone.repository, verdict: "pass", summary: "Fixture independent review.", checked: ["Fixture source review"], limitations: ["No live device checked"], reviewer: { kind: "isolated-agent", sessionId: "independent-session" }, implementationSessionId: "implementation-session" };
    const bytes = JSON.stringify(report);
    writeFileSync(join(f.directory, "phone-review.json"), bytes);
    f.evidence.reviews.phone = { kind: "retained-independent-session", artifact: { path: "phone-review.json", sha256: hash(bytes) } };
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).resolves.toMatchObject({ ascBuildId: f.evidence.phone.ascBuildId });
    report.verdict = "changes_requested";
    const failed = JSON.stringify(report);
    writeFileSync(join(f.directory, "phone-review.json"), failed);
    f.evidence.reviews.phone.artifact.sha256 = hash(failed);
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).rejects.toThrow("phone review");
  });

  it("accepts a fetched standalone Cloud review only at its exact input head", async () => {
    const f = fixture();
    const original = f.api.authority.review;
    const result = structuredClone(f.reviews.desktop);
    Object.assign(result.reviewer.job, { id: "standalone-review", kind: "implementation", baseSha: f.candidate.sha, sourceRef: "laterdog/input/standalone-review", brief: `Independently review ${f.candidate.sha}`, writeScopes: [".laterdog-review.json"] });
    f.evidence.reviews.desktop = { kind: "supervisor-standalone", jobId: result.reviewer.job.id, patchSha256: hash(result.patch.patch), implementationSessionId: "local-author-session" };
    f.api.authority.review = async review => review.kind === "supervisor-standalone" ? result : original(review);
    f.api.authority.reviewSource = async (_repository, baseSha) => ({ input: { sha: baseSha }, comparison: { merge_base_commit: { sha: baseSha } } });
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).resolves.toMatchObject({ reviewedSources: { desktop: f.candidate.sha } });
    result.reviewer.job.baseSha = "f".repeat(40);
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).rejects.toThrow("Standalone independent review");
  });

  it("accepts the valid internal TestFlight candidate before external distribution", async () => {
    const f = fixture();
    f.phoneRecord.beta.data.attributes = { internalBuildState: "IN_BETA_TESTING", externalBuildState: "READY_FOR_BETA_SUBMISSION" };
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).resolves.toMatchObject({ ascBuildId: f.evidence.phone.ascBuildId });
  });

  it("rejects an authoritative record failure without treating a local pass string as proof", async () => {
    const f = fixture();
    f.api.authority.phone = async () => { throw new Error("ASC unavailable"); };
    await expect(verifyReleaseAuthority({ ...f, api: f.api.authority })).rejects.toThrow("ASC unavailable");
  });

  it("records actual image providers and refuses floating pins or unrelated registry digests", () => {
    const f = fixture();
    const input = { sourceSha: f.evidence.cloud.sourceSha, repository: f.candidate.repository, runId: "8", image: `ghcr.io/o/later-dog-home:${f.evidence.cloud.sourceSha}`, inspection: [{ RepoDigests: [`ghcr.io/o/later-dog-home@${f.evidence.cloud.imageDigest}`], Config: { Labels: { "org.opencontainers.image.revision": f.evidence.cloud.sourceSha } }, Os: "linux", Architecture: "amd64" }], claudeOutput: "2.1.301 (Claude Code)\n", codexOutput: "codex-cli 0.163.0\n", dockerfile: f.dockerfile };
    expect(cloudImageReceipt(input)).toMatchObject({ imageDigest: f.evidence.cloud.imageDigest, providerVersions: f.evidence.providerVersions, platform: "linux/amd64" });
    for (const patch of [{ codexOutput: "codex-cli 0.154.0" }, { dockerfile: f.dockerfile.replace("@0.163.0", "") }, { image: "ghcr.io/o/later-dog-home:latest" }, { inspection: [{ RepoDigests: [] }] }]) expect(() => cloudImageReceipt({ ...input, ...patch })).toThrow();
  });
});
