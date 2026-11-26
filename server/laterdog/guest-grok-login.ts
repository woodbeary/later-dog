import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function currentGrokLogin(file: string, cli: string | undefined, now = Date.now(), refresh: NativeRefresh = refreshNative): Promise<string> {
  const raw = await readLogin(file);
  const saved = account(raw);
  if (!cli || !saved || saved.at > now || !saved.value.refresh_token) return raw;
  const previous = pending.get(file);
  if (previous) return previous;
  const run = (async () => {
    const isolated = await mkdtemp(join(tmpdir(), "laterdog-grok-login-"));
    try {
      const isolatedDir = join(isolated, ".grok");
      await mkdir(isolatedDir, { mode: 0o700 });
      const isolatedFile = join(isolatedDir, "auth.json");
      await writeFile(isolatedFile, JSON.stringify({ [saved.scope]: saved.value }), { mode: 0o600 });
      await refresh(cli, isolated);
      let renewed;
      try { renewed = account(await readLogin(isolatedFile)); } catch { return raw; }
      if (!renewed || renewed.scope !== saved.scope || !(renewed.at > now) || renewed.value.key === saved.value.key) return raw;
      for (const id of ["principal_id", "user_id", "team_id"]) if (saved.value[id] !== undefined && renewed.value[id] !== saved.value[id]) return raw;
      const original = await readLogin(file);
      if (original !== raw) throw new Error("The selected Grok sign-in changed during renewal. Start the turn again.");
      const updated = JSON.stringify({ ...saved.all, [saved.scope]: renewed.value }, null, 2);
      writeFileAtomic(file, updated, { mode: 0o600 });
      return updated;
    } finally { await rm(isolated, { recursive: true, force: true }); }
  })().finally(() => pending.delete(file));
  pending.set(file, run);
  return run;
}
