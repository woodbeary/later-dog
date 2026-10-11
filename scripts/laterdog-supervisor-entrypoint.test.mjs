import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ENTRYPOINT = new URL("../deploy/laterdog/entrypoint.sh", import.meta.url).pathname;

const STUBS = {
  curl: `#!/bin/sh
out=""; method=GET; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-X|--data-binary|--max-time|--retry|--retry-delay) [ "$1" = -X ] && method="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name="\${url##*/}"
echo "$method $name" >> "$STUB_LOG"
[ "$method" = PUT ] && exit 0
case " $STUB_FAIL " in *" $name "*) printf 500; exit 0 ;; esac
case " $STUB_STORED " in *" $name "*) printf stored > "$out"; printf 200; exit 0 ;; esac
printf 404
`,
  node: `#!/bin/sh
echo started > "$STUB_DIR/node-started"
printf data > "$LATERDOG_DATA_DIR/workspace.sqlite"
`,
  sqlite3: `#!/bin/sh
dest=$(printf %s "$2" | sed -e "s/^.backup '//" -e "s/'$//")
cp "$1" "$dest"
`,
  sha256sum: `#!/bin/sh
printf '%s  %s\\n' "$(cksum < "$1" | tr -d ' ')" "$1"
`,
  gh: "#!/bin/sh\nexit 1\n",
};

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function boot({ fail = "", stored = "" } = {}) {
  dir = mkdtempSync(join(tmpdir(), "ld-entry-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(dir, "curl.log");
  writeFileSync(log, "");
  const result = spawnSync("sh", [ENTRYPOINT], {
    cwd: dir,
    timeout: 20_000,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(dir, "home"),
      STUB_DIR: dir,
      STUB_LOG: log,
      STUB_FAIL: fail,
      STUB_STORED: stored,
      LATERDOG_STATE_URL: "http://state.test",
      LATERDOG_DATA_DIR: join(dir, "data"),
      LATERDOG_BACKUP_INTERVAL_SECONDS: "1",
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    requests: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    started: existsSync(join(dir, "node-started")),
  };
}

describe("the supervisor container's entrypoint", () => {
  it("stops before the supervisor starts when its saved state cannot be read, and never writes over it", () => {
    const run = boot({ fail: "workspace.sqlite", stored: "config.json" });
    expect(run.status).toBe(1);
    expect(run.started).toBe(false);
    expect(run.requests.filter((line) => line.startsWith("PUT"))).toEqual([]);
    expect(run.stderr).toContain("could not restore workspace.sqlite");
  });

  it("starts fresh when nothing is saved yet, and backs up what the supervisor wrote", () => {
    const run = boot();
    expect(run.status).toBe(0);
    expect(run.started).toBe(true);
    expect(run.requests).toContain("PUT workspace.sqlite");
  });

  it("restores what is saved and starts the supervisor", () => {
    const run = boot({ stored: "workspace.sqlite config.json" });
    expect(run.status).toBe(0);
    expect(run.started).toBe(true);
    expect(run.stderr).toContain("restored workspace.sqlite");
    expect(run.stderr).toContain("restored config.json");
  });
});
