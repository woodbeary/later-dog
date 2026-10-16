import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ACCEPTANCE_CHECKS, candidateManifest, PHONE_IDENTITY_FIELDS, RELEASE_ASSETS, verifyAcceptance, verifyCandidate } from "./laterdog-release-candidate.mjs";
import { promoteCandidate } from "./promote-laterdog-candidate.mjs";
import { releaseFiles } from "./laterdog-release-files.mjs";

const roots = [];
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
  const providerVersions = { claude: "2.1.111", codex: "0.154.0" };
  const checks = Object.fromEntries(ACCEPTANCE_CHECKS.map(name => [name, { status: "pass", evidence: `fixture evidence for ${name}`, sourceSha: name === "expo-development" ? phone.sourceSha : candidate.sha }]));
  Object.assign(checks["expo-development"], { appVersion: phone.appVersion, runtimeVersion: phone.runtimeVersion });
  for (const name of ["exact-testflight-build", "real-iphone", "desktop-mobile-compatibility"]) checks[name].phone = { ...phone };
  checks["real-iphone"].deviceType = "physical";
  for (const name of ["real-account-conversation", "workspace-identity", "independent-review"]) checks[name].phoneSourceSha = phone.sourceSha;
  for (const provider of ["claude", "codex"]) checks[`native-${provider}`].providerVersion = providerVersions[provider];
  const evidence = { schemaVersion: 2, sourceSha: candidate.sha, version: candidate.version, candidateRunId: candidate.runId, assets: Object.fromEntries(RELEASE_ASSETS.slice(0, 2).map(name => [name, candidate.files[name].sha256])), phone, providerVersions, checks };
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
  };
  return { directory, input, candidate, evidence, api, calls, uploaded };
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
});
