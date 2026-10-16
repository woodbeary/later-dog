import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const CLOUD_IMAGE_ARTIFACT = "later.dog-cloud-image-receipt";

export function providerPins(dockerfile) {
  const engines = /^ARG CLOUD_HOME_ENGINES="([^"]+)"$/m.exec(dockerfile)?.[1];
  const claude = /(?:^| )@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)(?: |$)/.exec(engines ?? "")?.[1];
  const codex = /(?:^| )@openai\/codex@(\d+\.\d+\.\d+)(?: |$)/.exec(engines ?? "")?.[1];
  if (!claude || !codex) throw new Error("Cloud provider versions must be pinned in the source Dockerfile.");
  return { claude, codex };
}

export function cloudImageReceipt({ sourceSha, repository, runId, image, inspection, claudeOutput, codexOutput, dockerfile }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[1-9]\d*$/.test(String(runId))) throw new Error("Invalid Cloud image workflow identity.");
  const imageRepository = `ghcr.io/${repository.split("/")[0].toLowerCase()}/later-dog-home`;
  if (image !== `${imageRepository}:${sourceSha}`) throw new Error("Cloud image must use its full source SHA tag.");
  const descriptor = inspection?.[0];
  const digest = descriptor?.RepoDigests?.find(value => value.startsWith(`${imageRepository}@sha256:`))?.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "") || descriptor.Config?.Labels?.["org.opencontainers.image.revision"] !== sourceSha) throw new Error("Cloud registry digest or source label could not be verified.");
  const providerVersions = {
    claude: /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/.exec(claudeOutput.trim())?.[1],
    codex: /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/.exec(codexOutput.trim())?.[1],
  };
  const pins = providerPins(dockerfile);
  if (Object.keys(pins).some(provider => pins[provider] !== providerVersions[provider])) throw new Error("Built Cloud provider binaries differ from the source pins.");
  return { schemaVersion: 1, sourceSha, repository, runId: String(runId), imageRepository, imageDigest: digest, providerVersions, platform: `${descriptor.Os}/${descriptor.Architecture}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(["sha", "repository", "run-id", "image", "directory"].map(name => [name, { type: "string" }])) });
  const docker = args => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60_000 });
  const receipt = cloudImageReceipt({ sourceSha: values.sha, repository: values.repository, runId: values["run-id"], image: values.image,
    inspection: JSON.parse(docker(["image", "inspect", values.image])),
    claudeOutput: docker(["run", "--rm", "--entrypoint", "claude", values.image, "--version"]),
    codexOutput: docker(["run", "--rm", "--entrypoint", "codex", values.image, "--version"]),
    dockerfile: readFileSync("Dockerfile", "utf8"),
  });
  const directory = resolve(values.directory ?? "out");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "cloud-image.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Recorded ${receipt.imageRepository}@${receipt.imageDigest} from ${receipt.sourceSha}.`);
}
