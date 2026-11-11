import { describe, expect, it } from "vitest";
import { HeavyCommandGuard, heavyCommandKind, preToolUseDecision } from "./heavy-commands.ts";

const MISSED_BEFORE_THE_EVALUATION = [
  "timeout 300 npx tsc --noEmit -p . 2>&1 | head -20",
  "cd app && pnpm exec vitest run",
  "pnpm vitest run",
  "node --test test/*.test.ts",
  "node --experimental-strip-types --test \"server/**/*.test.ts\" 2>&1 | tail -5",
  "npx vitest run --coverage",
  "python3 -m playwright install chromium",
  "python3 -m pytest -x",
  "pytest tests/ -q",
  "make -j8",
  "make build",
  "/opt/tools/bin/ffmpeg -y -i in.mov -c:v libx264 -crf 20 out.mp4",
  "FF=/opt/tools/bin/ffmpeg; $FF -v error -y -i a.mov -vf scale=1280:-2 b.mp4",
  "for f in *.mov; do ffmpeg -i \"$f\" \"${f%.mov}.mp4\"; done",
  "npx expo export --platform ios",
  "pnpm --filter web test",
  "node node_modules/typescript/bin/tsc --noEmit",
  "node_modules/.bin/vitest run",
  "./node_modules/.bin/tsc -b",
  "sudo apt-get update && sudo apt-get install -y build-essential",
  "npx create-next-app@latest site --ts --use-pnpm",
  "npm rebuild sharp",
  "timeout 2400 pnpm test > /tmp/pnpm-test.log 2>&1; echo \"exit $?\"",
];

const HEAVY_IN_OTHER_SHAPES = [
  "pnpm --dir apps/web install",
  "npm --prefix server ci",
  "npm install --prefix functions",
  "npm i",
  "pnpm -C packages/ui typecheck",
  "pnpm -r --parallel test",
  "yarn workspace web build",
  "bun test",
  "bunx vitest",
  "vitest",
  "npx jest --ci",
  "jest --coverage",
  "pytest",
  "pytest -v",
  "python -m pytest tests",
  "node --test",
  "go test ./... -v",
  "go test -v ./...",
  "timeout 600 cargo test --workspace",
  "cargo check",
  "cargo run --release",
  "sudo dnf install -y gcc",
  "brew install ffmpeg",
  "apk add --no-cache git",
  "make",
  "make test",
  "nice -n 10 make -j4 all",
  "PY=python3; $PY -m pip install torch",
  "if [ -f package.json ]; then pnpm install; fi",
  "while read d; do (cd \"$d\" && npm test); done < dirs.txt",
  "npx tsc -b --watch",
  "tsc -p tsconfig.json --noEmit",
  "pnpm dlx create-vite@latest app",
  "npm create vite@latest app",
  "docker buildx build --platform linux/amd64 .",
  "podman build .",
  "./gradlew test",
  "xcodebuild test -scheme App",
  "npx playwright install chromium",
  "uv pip install -r requirements.txt",
  "ffmpeg -i a.mp4 -vn a.mp3 2>/dev/null",
  "npm run build:prod",
  "pnpm run test:unit",
  "export CI=1; pnpm test",
  "pnpm test -- --reporter verbose",
  "npx vitest run server",
  "pnpm vitest run server/decider scripts",
  "pytest tests/unit tests/api -q",
  "node --test \"test/**/*.test.mjs\"",
  "cd /data/site && git pull -q && npm ci --omit=dev",
  "pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -3",
  "NODE_OPTIONS=--max-old-space-size=4096 pnpm build",
  "npx --yes tsc --noEmit",
  "pnpm exec tsc -b",
  "yarn install --immutable",
  "yarn test",
  "bun run build",
  "npm run typecheck && npm run lint",
  "npx vitest",
  "npx vitest run --reporter=dot",
  "pnpm exec vitest run server/laterdog",
  "pytest -x -q tests",
  "python3 -m pytest",
  "cargo clippy --all-targets",
  "cargo build",
  "go build -o bin/app ./cmd/app",
  "docker compose -f docker-compose.dev.yml up -d",
  "docker-compose build web",
  "docker run --rm -v \"$PWD\":/src node:24 npm test",
  "apt-get install -y ffmpeg",
  "pip3 install --user yt-dlp",
  "ffmpeg -ss 00:00:05 -i clip.mp4 -frames:v 1 shot.png",
  "npx playwright test tests/login.spec.ts",
  "npx next build && npx next start",
  "swift build",
  "gradle assemble",
];

const HEAVY_INSIDE_SHELL_TEXT = [
  "bash -lc \"cd app && pnpm test\"",
  "sh -c 'npm ci && npm run build'",
  "bash <<'EOF'\npnpm install\npnpm build\nEOF",
];

const ASKS_OR_REHEARSES = [
  "ffmpeg -version",
  "pnpm -v",
  "npm -h",
  "tsc --version",
  "tsc -v",
  "npx tsc --help",
  "npx vitest --version",
  "pytest --version",
  "cargo -V",
  "docker --version",
  "make --version",
  "make -n",
  "make --dry-run all",
  "ffmpeg -h",
  "pip install --help",
  "npm install --dry-run",
  "pnpm install --help 2>&1 | head -20",
  "xcodebuild -version",
  "mvn -v",
  "pytest --collect-only -q",
  "yarn --version",
  "bun --version",
  "pip --version",
  "ffmpeg -version | head -1",
  "whisper --help | head",
];

const ONE_TEST_FILE = [
  "npx vitest run src/one.test.ts",
  "pnpm vitest run server/decider/decider.test.ts",
  "pnpm exec vitest run src/a.test.ts -t \"routes a message\"",
  "npx vitest run server/a.test.ts server/b.test.ts",
  "pytest tests/test_one.py::test_name -q",
  "python -m pytest tests/test_api.py -k login",
  "node --test test/one.test.ts",
  "node --experimental-strip-types --test server/a.test.ts",
  "jest src/a.test.tsx",
  "npx vitest run scripts/decision-eval/decision-eval.test.ts",
  "pnpm exec vitest run server/laterdog/heavy-commands.test.ts --reporter dot",
  "node --test scripts/dev-desktop.node-test.mjs",
  "pytest tests/test_login.py -k \"signs in\" -x",
  "python3 -m pytest tests/test_one.py -q",
];

const WRITTEN_NOT_RUN = [
  "rg -n \"docker build\" .github",
  "git commit -m \"make build faster\"",
  "echo \"pytest -v\"",
  "cat > run.sh <<'EOF'\n#!/bin/sh\npnpm install\npnpm test\nEOF",
  "cat <<EOF > notes.md\nRun make build, then cargo test.\nEOF",
  "tee -a README.md <<'DOC'\nnpm install\nDOC",
  "python3 - <<'PY'\nprint('pip install nothing')\nPY",
  "bash -c \"echo pnpm install\"",
  "sh -c 'ls -la'",
  "git commit -m \"Run pnpm install before the build\"",
];

const QUICK_IN_OTHER_SHAPES = [
  "go version",
  "grep -rn \"make build\" docs",
  "cat Makefile",
  "which make",
  "timeout 5 curl -s localhost:3000",
  "FOO=bar; echo $FOO",
  "X=pnpm; echo $X",
  "$EDITOR notes.md",
  "npx tsx scripts/one.ts",
  "apt list --installed | grep ffmpeg",
  "brew list",
  "docker compose ps",
  "docker compose logs web --tail 50",
  "ls node_modules/.bin/vitest",
  "cat node_modules/typescript/bin/tsc | head -5",
  "node -v",
  "python3 -V",
  "git log --grep \"npm install\"",
  "gh pr checks 158",
  "node --experimental-strip-types scripts/decision-eval.ts score --responses r.json",
  "git log --oneline | grep -i \"cargo build\"",
  "sed -n 1,20p Makefile",
  "ls",
  "pwd && ls -la",
  "cat package.json",
  "pnpm why vitest",
  "pnpm outdated",
  "npm pkg get version",
  "docker compose version",
  "docker compose down",
  "docker inspect web",
  "pip freeze | grep -i torch",
  "cargo metadata --no-deps --format-version 1 | head -c 300",
  "go env GOPATH",
  "ffprobe -v error -show_streams clip.mp4",
  "curl -fsSL https://example.com/install.sh -o /tmp/install.sh",
  "gh run list --limit 5",
  "kill %1",
  "tail -f /tmp/build.log",
  "node scripts/no-comments.ts --write",
  "git diff --stat -- server/laterdog/heavy-commands.ts",
  "echo done > /tmp/make.done",
];

describe("the rule the evaluation widened", () => {
  it.each(MISSED_BEFORE_THE_EVALUATION)("sends a command the old rule let through to the cloud computer: %s", (command) => {
    expect(heavyCommandKind(command)).not.toBeNull();
  });

  it.each(HEAVY_IN_OTHER_SHAPES)("sends %s to the cloud computer", (command) => {
    expect(heavyCommandKind(command)).not.toBeNull();
  });

  it.each(HEAVY_INSIDE_SHELL_TEXT)("reads the commands a shell is handed as text: %s", (command) => {
    expect(heavyCommandKind(command)).not.toBeNull();
  });

  it.each(ASKS_OR_REHEARSES)("lets a version, help, dry-run or listing request run here: %s", (command) => {
    expect(heavyCommandKind(command)).toBeNull();
  });

  it.each(ONE_TEST_FILE)("lets named test files run here: %s", (command) => {
    expect(heavyCommandKind(command)).toBeNull();
  });

  it.each(WRITTEN_NOT_RUN)("lets text that is written, searched or printed run here: %s", (command) => {
    expect(heavyCommandKind(command)).toBeNull();
  });

  it.each(QUICK_IN_OTHER_SHAPES)("lets %s run here", (command) => {
    expect(heavyCommandKind(command)).toBeNull();
  });

  it("names what kind of work it saw", () => {
    expect(heavyCommandKind("sudo apt-get install -y build-essential")).toBe("a package install");
    expect(heavyCommandKind("npm create vite@latest app")).toBe("a package install");
    expect(heavyCommandKind("pnpm vitest run")).toBe("a build or test suite");
    expect(heavyCommandKind("make -j8")).toBe("a build or test suite");
    expect(heavyCommandKind("docker-compose build web")).toBe("a container build or run");
    expect(heavyCommandKind("FF=/opt/tools/bin/ffmpeg; $FF -v error -i a.mov b.mp4")).toBe("media processing");
  });

  it("treats a lone -v as a version request, except where it means verbose", () => {
    expect(heavyCommandKind("npx tsc -v")).toBeNull();
    expect(heavyCommandKind("python3 -m pip -V")).toBeNull();
    expect(heavyCommandKind("pytest -v")).not.toBeNull();
    expect(heavyCommandKind("cargo test -v")).not.toBeNull();
    expect(heavyCommandKind("docker run --rm -v /data:/data builder make")).not.toBeNull();
  });

  it("keeps a test run heavy when a filter is not a file", () => {
    expect(heavyCommandKind("npx vitest run -t \"routes a message\"")).not.toBeNull();
    expect(heavyCommandKind("npx vitest run decider")).not.toBeNull();
    expect(heavyCommandKind("pytest -k login")).not.toBeNull();
    expect(heavyCommandKind("npx vitest run \"server/**/*.test.ts\"")).not.toBeNull();
  });

  it("decides at once however many flags and redirects a command carries", () => {
    const started = performance.now();
    expect(heavyCommandKind(`pnpm ${"--flag ".repeat(60)}lint`)).toBeNull();
    expect(heavyCommandKind(`pnpm ${"--filter -x ".repeat(60)}lint`)).toBeNull();
    expect(heavyCommandKind(`tool -v ${">a".repeat(60)} extra`)).toBeNull();
    expect(heavyCommandKind(`pnpm ${"--flag ".repeat(60)}test`)).toBe("a build or test suite");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads a shell handed to a shell", () => {
    expect(heavyCommandKind("bash -c 'sh -c \"pnpm install\"'")).toBe("a package install");
    expect(heavyCommandKind("bash -c 'sh -c \"git status\"'")).toBeNull();
  });
});

describe("heavy commands on a shared Cloud home", () => {
  it("recognises installs, builds, suites, containers and media work, even after cd, env or a pipe", () => {
    for (const command of [
      "pnpm install",
      "pnpm i --frozen-lockfile",
      "cd site && npm ci",
      "yarn",
      "bun add zod",
      "CI=1 pnpm test",
      "npm run build 2>&1 | tail -20",
      "pnpm -s typecheck",
      "npx tsc --noEmit",
      "npx playwright test",
      "next build",
      "pip install -r requirements.txt",
      "python3 -m pip install numpy",
      "uv sync",
      "cargo build --release",
      "docker build -t app .",
      "ffmpeg -i in.mov out.mp4",
      "time pnpm build",
      "(cd web; pnpm install)",
    ]) expect(heavyCommandKind(command), command).not.toBeNull();
  });

  it("leaves quick commands, version checks and single test files alone", () => {
    for (const command of [
      "ls -la",
      "git status",
      "pnpm --version",
      "node --version",
      "npx vitest run src/one.test.ts",
      "pytest tests/test_one.py",
      "cat package.json | grep build",
      "echo 'pnpm install'",
      "rg 'npm test' docs",
      "pnpm why react",
      "npm view react version",
      "ps aux | grep -E 'node|bun' | head",
      "ps -eo pid,args | grep -E \"node|bun|yarn\"",
      "pgrep -af 'claude|pnpm'",
    ]) expect(heavyCommandKind(command), command).toBeNull();
  });

  it("still splits on pipes and separators outside quotes", () => {
    expect(heavyCommandKind("echo 'a|b' && pnpm install")).toBe("a package install");
    expect(heavyCommandKind("echo \"x;y\" | bun add zod")).toBe("a package install");
    expect(heavyCommandKind("out=$(pnpm build)")).not.toBeNull();
  });

  it("refuses a heavy command once per chat and lets the same command through when the dog runs it again", () => {
    let now = 1_000;
    const guard = new HeavyCommandGuard(() => now);
    const first = guard.check("thread-a", "pnpm install");
    expect(first).toContain("run_on_computer");
    expect(first).toContain("run the same command here again");
    expect(guard.check("thread-b", "pnpm install")).not.toBeNull();
    expect(guard.check("thread-a", "pnpm   install")).toBeNull();
    expect(guard.check("thread-a", "pnpm install")).not.toBeNull();
    now += 31 * 60_000;
    expect(guard.check("thread-a", "pnpm install")).not.toBeNull();
    expect(guard.check("thread-a", "git status")).toBeNull();
  });
});

describe("the PreToolUse decision a Cloud home gives the engine", () => {
  const payload = (command: unknown, tool = "Bash") => ({ tool_name: tool, tool_input: { command } });

  it("denies a heavy shell command with the reason the engine shows the dog", () => {
    const decision = preToolUseDecision(new HeavyCommandGuard(), { active: true, threadId: "t", payload: payload("pnpm install") });
    expect(decision).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(String(decision?.permissionDecisionReason)).toContain("run_on_computer");
  });

  it("stays out of the way off a Cloud home, for other tools, quick commands and malformed input", () => {
    const guard = new HeavyCommandGuard();
    expect(preToolUseDecision(guard, { active: false, threadId: "t", payload: payload("pnpm install") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload("pnpm install", "Read") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload("git status") })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: payload(42) })).toBeNull();
    expect(preToolUseDecision(guard, { active: true, threadId: "t", payload: {} })).toBeNull();
  });
});
