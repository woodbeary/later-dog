import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { execCli } from "../procs.ts";

type Login = Record<string, Record<string, unknown>>;
type NativeRefresh = (cli: string, home: string) => Promise<void>;

const issuer = /^https:\/\/(?:auth\.x\.ai(?:::[a-zA-Z0-9-]+)?|accounts\.x\.ai\/sign-in)$/;

function account(raw: string) {
  const all: unknown = JSON.parse(raw);
  if (!all || typeof all !== "object" || Array.isArray(all)) return null;
  const matches = Object.entries(all as Login).filter(([scope, entry]) => issuer.test(scope) && entry && typeof entry === "object" && typeof entry.key === "string");
  if (matches.length !== 1) return null;
  const [scope, value] = matches[0]!;
  const expires = value.expires_at;
  const at = typeof expires === "number" ? (expires < 1e12 ? expires * 1000 : expires) : typeof expires === "string" ? Date.parse(expires) : expires === undefined ? Infinity : NaN;
  return { scope, value, at, all: all as Login };
}

async function readLogin(file: string) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("The selected Grok login is invalid.");
    return await fd.readFile("utf8");
  } finally { await fd.close(); }
}

const refreshNative: NativeRefresh = (cli, home) => new Promise<void>(resolve => {
  execCli(cli, ["--no-auto-update", "models"], {
    env: { HOME: home, GROK_HOME: join(home, ".grok"), PATH: process.env.PATH, NO_COLOR: "1" },
    cwd: home, timeout: 30_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL",
  }, () => resolve());
});

const pending = new Map<string, Promise<string>>();

export async function currentGrokLogin(file: string, cli: string | undefined, now = Date.now(), refresh: NativeRefresh = refreshNative, publish = writeFileAtomic): Promise<string> {
  const raw = await readLogin(file);
  const saved = account(raw);
  if (!cli || !saved || saved.at > now || !saved.value.refresh_token) return raw;
  const previous = pending.get(file);
  if (previous) return previous;
  const run = (async () => {
    const privateDir = join(dirname(file), ".laterdog-renewals");
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const info = await lstat(privateDir);
    if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("Grok renewal needs a private account folder.");
    const prefix = createHash("sha256").update(raw).digest("hex") + "-";
    const accept = async (isolated: string) => {
      let renewed;
      try { renewed = account(await readLogin(join(isolated, ".grok", "auth.json"))); } catch { return; }
      if (!renewed || renewed.scope !== saved.scope || !(renewed.at > now) || renewed.value.key === saved.value.key) return;
      for (const id of ["principal_id", "user_id", "team_id"]) if (saved.value[id] !== undefined && renewed.value[id] !== saved.value[id]) return;
      return JSON.stringify({ ...saved.all, [saved.scope]: renewed.value }, null, 2);
    };
    const commit = async (isolated: string, updated: string) => {
      if (await readLogin(file) !== raw) {
        await rm(isolated, { recursive: true, force: true });
        throw new Error("The selected Grok sign-in changed during renewal. Start the turn again.");
      }
      publish(file, updated, { mode: 0o600 });
      await rm(isolated, { recursive: true, force: true });
      return updated;
    };
    for (const entry of await readdir(privateDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const previous = join(privateDir, entry.name);
      const updated = await accept(previous);
      if (updated) return commit(previous, updated);
    }
    const isolated = await mkdtemp(join(privateDir, prefix));
    let updated;
    try {
      const isolatedDir = join(isolated, ".grok");
      await mkdir(isolatedDir, { mode: 0o700 });
      await writeFile(join(isolatedDir, "auth.json"), JSON.stringify({ [saved.scope]: saved.value }), { mode: 0o600 });
      await refresh(cli, isolated);
      updated = await accept(isolated);
    } finally {
      if (!updated) await rm(isolated, { recursive: true, force: true });
    }
    return updated ? commit(isolated, updated) : raw;
  })().finally(() => pending.delete(file));
  pending.set(file, run);
  return run;
}
