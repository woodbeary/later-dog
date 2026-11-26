import { posix } from "node:path";
import { resolveAntigravityReleaseAsset } from "../drivers/antigravity-release.ts";

export type GuestDriverRuntime =
  | { kind: "grok" | "cursor" | "antigravity" }
  | { kind: "package"; name: string; version: string; binary: string }
  | { kind: "installed"; binary: string };

export const GUEST_CLI_BASE = "/home/dog/.laterdog-engine/cli";
const grokVersion = "1.0.41";
const cursorVersion = "2026.10.16-e3cb207";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const packages: Record<string, string> = {
  "@google/gemini-cli": "gemini",
  "@qwen-code/qwen-code": "qwen",
  "@earendil-works/pi-coding-agent": "pi",
  "opencode-ai": "opencode",
};

function runtimeDirectory(runtime: GuestDriverRuntime): string {
  if (runtime.kind === "grok") return posix.join(GUEST_CLI_BASE, "grok-" + grokVersion);
  if (runtime.kind === "cursor") return posix.join(GUEST_CLI_BASE, "cursor-" + cursorVersion);
  if (runtime.kind === "antigravity") return posix.join(GUEST_CLI_BASE, "antigravity-" + resolveAntigravityReleaseAsset("linux", "x64")!.version);
  if (runtime.kind === "package" && packages[runtime.name] === runtime.binary && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtime.version)) {
    return posix.join(GUEST_CLI_BASE, runtime.binary + "-" + runtime.version);
  }
  throw new Error("The selected engine has no verified computer runtime.");
}

export function guestCliBinary(runtime: GuestDriverRuntime): string {
  if (runtime.kind === "installed") {
    if (!/^[\w][\w.+-]{0,79}$/.test(runtime.binary)) throw new Error("The custom engine must name an executable installed on the computer.");
    return runtime.binary;
  }
  const dir = runtimeDirectory(runtime);
  if (runtime.kind === "package") return posix.join(dir, "node_modules", ".bin", runtime.binary);
  return posix.join(dir, runtime.kind === "antigravity" ? "agy_acp_server.par" : runtime.kind === "cursor" ? "cursor-agent" : "grok");
}

export function guestCliPreparation(runtime: GuestDriverRuntime): string {
  const executable = guestCliBinary(runtime);
  if (runtime.kind === "installed") return "command -v " + quote(executable) + " >/dev/null";
  const dir = runtimeDirectory(runtime);
  const ready = "test -x " + quote(executable) + " && test -f " + quote(posix.join(dir, ".ready"));
  const packageInstall = runtime.kind === "package";
  let install: string;
  if (packageInstall) {
    install = 'corepack pnpm@10.33.0 --dir "$tmp" add --save-exact --ignore-workspace ' + quote(runtime.name + "@" + runtime.version);
  } else {
    const x64 = resolveAntigravityReleaseAsset("linux", "x64")!;
    const arm = resolveAntigravityReleaseAsset("linux", "arm64")!;
    const source = (arch: "x64" | "arm64") => {
      if (runtime.kind === "antigravity") {
        const asset = arch === "x64" ? x64 : arm;
        return [asset.url, asset.sha256];
      }
      if (runtime.kind === "cursor") return ["https://downloads.cursor.com/lab/" + cursorVersion + "/linux/" + arch + "/agent-cli-package.tar.gz", arch === "x64" ? "3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552" : "4cf077f150eb8d1e270bf1dea69700184c39a4847fe192d523f5bb34d4b62597"];
      return ["https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-" + grokVersion + "-linux-" + (arch === "x64" ? "x86_64" : "aarch64"), arch === "x64" ? "9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407" : "7c0b8c973af6a78e2037f19ed93033471b8c5e722f9ff04b86b092e066e60d74"];
    };
    const vars = (arch: "x64" | "arm64") => { const [url, sha] = source(arch); return "url=" + quote(url!) + "; sha=" + quote(sha!); };
    const extract = runtime.kind === "cursor" ? 'tar --strip-components=1 --no-same-owner --no-same-permissions -xzf "$tmp/archive" -C "$tmp"'
      : runtime.kind === "antigravity" ? 'unzip -joq "$tmp/archive" "*agy_acp_server.par" "*localharness_external" -d "$tmp" && chmod 755 "$tmp/agy_acp_server.par" "$tmp/localharness_external"'
      : 'mv "$tmp/archive" "$tmp/grok" && chmod 755 "$tmp/grok"';
    install = [
      'case "$(uname -m)" in x86_64|amd64) ' + vars("x64") + ';; aarch64|arm64) ' + vars("arm64") + ';; *) exit 1;; esac',
      'curl --fail --silent --show-error --location --proto "=https" --proto-redir "=https" --retry 2 "$url" -o "$tmp/archive"',
      'printf "%s  %s\\n" "$sha" "$tmp/archive" | sha256sum -c - >/dev/null',
      extract,
      'rm -f "$tmp/archive"',
    ].join("\n");
  }
  return [
    "(set -eu",
    "umask 077",
    "mkdir -p " + quote(GUEST_CLI_BASE),
    "exec 8>" + quote(dir + ".install.lock"),
    "flock 8",
    "if " + ready + "; then exit 0; fi",
    "tmp=$(mktemp -d " + quote(dir + ".XXXXXXXX") + ")",
    'trap \'rm -rf "$tmp"\' EXIT',
    install,
    'test -x "$tmp"/' + quote(posix.relative(dir, executable)),
    'touch "$tmp/.ready"',
    'mv -T "$tmp" ' + quote(dir),
    ")",
  ].join("\n");
}
