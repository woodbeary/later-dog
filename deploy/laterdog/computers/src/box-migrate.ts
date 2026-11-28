import type { ComputerView, ExecResult, Result } from "./computer";
import type { ExecInput } from "./inputs";
import { profileKey } from "./box-routes";

export const MOVE_DIR = "/tmp/laterdog-box-move";
export const MOVE_PART_BYTES = 15 * 1024 * 1024;
export const SNAPSHOT_LIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;

export interface MovableComputer {
  describe(): Promise<Result<ComputerView>>;
  wake(input?: { fullAllowance?: boolean }): Promise<Result<ComputerView>>;
  exec(input: ExecInput): Promise<Result<ExecResult>>;
  readFile(path: string): Promise<Result<Uint8Array>>;
}

export interface InventoryRow {
  computer: string;
  name: string;
  state: string;
  lastActiveAt: string;
  snapshotAt: string | null;
  snapshotDaysLeft: number | null;
  packaged: { bytes: number; sha256: string; savedAt: string } | null;
}

export function inventoryRow(view: ComputerView, packaged: InventoryRow["packaged"], now = Date.now()): InventoryRow {
  const taken = view.snapshotAt ? Date.parse(view.snapshotAt) : NaN;
  return {
    computer: view.id, name: view.name, state: view.state, lastActiveAt: view.lastActiveAt, snapshotAt: view.snapshotAt ?? null,
    snapshotDaysLeft: Number.isFinite(taken) ? Math.floor((taken + SNAPSHOT_LIFE_DAYS * DAY_MS - now) / DAY_MS) : null,
    packaged,
  };
}

export const CLI_LOGINS = [".config/gh", ".ssh", ".npmrc", ".gitconfig", ".git-credentials", ".netrc", ".docker/config.json"] as const;

export function packScript(dog: string): string {
  const cli = CLI_LOGINS.map((path) => `[ -e "$HOME/${path}" ] && cli+=("${path}")`).join("; ");
  return [
    "set -euo pipefail",
    `rm -rf ${MOVE_DIR} && mkdir -p ${MOVE_DIR} && cd ${MOVE_DIR}`,
    "profile=$HOME/.config/chromium",
    `cli=(); ${cli}; true`,
    "[ -d \"$profile\" ] || [ ${#cli[@]} -gt 0 ] || { echo 'none'; exit 0; }",
    "sites=$(python3 -c \"import sqlite3,sys,glob\nn=set()\nfor f in glob.glob(sys.argv[1]+'/*/Cookies')+glob.glob(sys.argv[1]+'/*/Network/Cookies'):\n  try:\n    c=sqlite3.connect('file:'+f+'?mode=ro&immutable=1',uri=True)\n    n.update(r[0].lstrip('.') for r in c.execute('select distinct host_key from cookies'))\n  except Exception: pass\nprint(len(n))\" \"$profile\" 2>/dev/null || echo 0)",
    "parts=(); [ -d \"$profile\" ] && parts+=(-C \"$HOME/.config\" chromium); [ ${#cli[@]} -gt 0 ] && parts+=(-C \"$HOME\" \"${cli[@]}\")",
    `tar -czf profile.tgz --warning=no-file-changed --ignore-failed-read --exclude='Singleton*' --exclude='*/Cache' --exclude='*/Code Cache' --exclude='*/GPUCache' --exclude='*/Service Worker/CacheStorage' --transform 's,^chromium,${dog}/chromium,' --transform 's,^\\.,${dog}/home/.,' "\${parts[@]}" || [ $? -le 1 ]`,
    `split -b ${MOVE_PART_BYTES} -d -a 3 profile.tgz part.`,
    "echo \"sha256 $(sha256sum profile.tgz | cut -d' ' -f1)\"",
    "echo \"bytes $(stat -c %s profile.tgz)\"",
    "echo \"sites $sites\"",
    "echo \"cli ${cli[*]}\"",
    "ls part.* | tr '\\n' ' '",
  ].join("\n");
}

export interface Packed { sha256: string; bytes: number; sites: number; cli: string[]; parts: string[] }

export function readPacked(stdout: string): Packed | "none" | null {
  if (stdout.trim() === "none") return "none";
  const line = (name: string) => stdout.split("\n").find((entry) => entry.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? "";
  const sha256 = line("sha256");
  const bytes = Number(line("bytes"));
  const parts = stdout.trim().split("\n").at(-1)!.trim().split(/\s+/).filter((part) => /^part\.\d{3}$/.test(part));
  if (!SHA256.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0 || !parts.length) return null;
  return { sha256, bytes, sites: Number(line("sites")) || 0, cli: line("cli").split(/\s+/).filter(Boolean), parts };
}

export type MoveOutcome =
  | { ok: true; dog: string; computer: string; bytes: number; sha256: string; sites: number; cliLogins: string[]; seconds: number }
  | { ok: false; status: number; code: string; message: string };

const failed = (status: number, code: string, message: string): MoveOutcome => ({ ok: false, status, code, message });

async function awake(computer: MovableComputer, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  let woke = false;
  while (Date.now() < until) {
    const view = await computer.describe();
    if (!view.ok) return false;
    if (view.value.state === "running") return true;
    if (!woke && view.value.state === "sleeping") { woke = true; await computer.wake({}); }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

async function digest(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hasher = new crypto.DigestStream("SHA-256");
  await stream.pipeTo(hasher);
  return [...new Uint8Array(await hasher.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function moveProfile(input: { computer: MovableComputer; computerId: string; dog: string; person: string; bucket: R2Bucket; wakeMs?: number }): Promise<MoveOutcome> {
  const started = Date.now();
  if (!(await awake(input.computer, input.wakeMs ?? 6 * 60_000))) return failed(503, "computer_asleep", "The dog's computer did not wake.");
  const packed = await input.computer.exec({ command: packScript(input.dog), timeoutMs: 10 * 60_000 });
  if (!packed.ok) return failed(packed.refusal.status, packed.refusal.code, packed.refusal.message);
  if (packed.value.exitCode !== 0) return failed(502, "pack_failed", `Packing the browser profile failed: ${packed.value.stderr.slice(0, 300)}`);
  const found = readPacked(packed.value.stdout);
  if (found === "none") return failed(404, "no_profile", "The dog's computer has no browser profile or command-line logins.");
  if (!found) return failed(502, "pack_unreadable", "The packed profile could not be read.");
  const key = profileKey(input.person, input.dog);
  const upload = await input.bucket.createMultipartUpload(key, { customMetadata: { sha256: found.sha256, savedAt: new Date().toISOString(), movedAt: new Date().toISOString(), from: input.computerId, sites: String(found.sites) } });
  try {
    const parts: R2UploadedPart[] = [];
    for (const [index, name] of found.parts.entries()) {
      const read = await input.computer.readFile(`${MOVE_DIR}/${name}`);
      if (!read.ok) throw new Error(read.refusal.message);
      parts.push(await upload.uploadPart(index + 1, read.value));
    }
    await upload.complete(parts);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    return failed(502, "copy_failed", `Copying the profile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stored = await input.bucket.get(key);
  const check = stored ? await digest(stored.body) : "";
  await input.computer.exec({ command: `rm -rf ${MOVE_DIR}`, timeoutMs: 60_000 }).catch(() => undefined);
  if (check !== found.sha256 || stored?.size !== found.bytes) {
    await input.bucket.delete(key);
    return failed(502, "checksum_mismatch", "The copied profile did not match the computer's checksum and was removed.");
  }
  return { ok: true, dog: input.dog, computer: input.computerId, bytes: found.bytes, sha256: found.sha256, sites: found.sites, cliLogins: found.cli, seconds: Math.round((Date.now() - started) / 1000) };
}

export const RETIRE_AFTER_QUIET_DAYS = 14;

export interface MovedPackage { dog: string; from?: string; movedAt?: string; savedAt: string; sha256: string }

export interface RetirementRow {
  computer: string;
  name: string;
  dog: string | null;
  retirable: boolean;
  reason: string;
  quietSince: string | null;
  retirableFrom: string | null;
}

export function retirementCheck(views: ComputerView[], packages: MovedPackage[], now = Date.now()): RetirementRow[] {
  return views.map((view) => {
    const moved = packages.filter((entry) => entry.from === view.id).sort((a, b) => Date.parse(b.movedAt ?? b.savedAt) - Date.parse(a.movedAt ?? a.savedAt))[0];
    const row = { computer: view.id, name: view.name, dog: moved?.dog ?? null, quietSince: null as string | null, retirableFrom: null as string | null };
    if (!moved) return { ...row, retirable: false, reason: "Its logins have not been moved to the box." };
    const movedAt = Date.parse(moved.movedAt ?? moved.savedAt);
    const lastActive = Date.parse(view.lastActiveAt);
    const quietSince = Math.max(movedAt, Number.isFinite(lastActive) ? lastActive : movedAt);
    const from = quietSince + RETIRE_AFTER_QUIET_DAYS * DAY_MS;
    const timed = { ...row, quietSince: new Date(quietSince).toISOString(), retirableFrom: new Date(from).toISOString() };
    if (view.state !== "sleeping") return { ...timed, retirable: false, reason: `It is ${view.state}, not asleep.` };
    if (Number.isFinite(lastActive) && lastActive > movedAt) return { ...timed, retirable: false, reason: "It woke after its logins were moved; move them again first." };
    if (now < from) return { ...timed, retirable: false, reason: `It has to stay asleep until ${new Date(from).toISOString().slice(0, 10)}.` };
    return { ...timed, retirable: true, reason: `Asleep for ${RETIRE_AFTER_QUIET_DAYS}+ days since its logins moved; its package stays in storage for 90 days.` };
  });
}
