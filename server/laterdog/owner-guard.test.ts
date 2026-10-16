import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ownerGuard, ownerGuardRequest, ownerWorkspaceRoots, systemGit, type GitLookup, type OwnerGuardContext } from "./owner-guard.ts";

const workspace = "/srv/laterdog/task-workspaces/dog-1/thread-1";
const repo = `${workspace}/later-dog`;
const git = (current: string | null, defaults: Record<string, string> = {}): GitLookup => ({
  currentBranch: async () => current,
  defaultBranch: async (_dir, remote) => defaults[remote] ?? null,
});
const context = (overrides: Partial<OwnerGuardContext> = {}): OwnerGuardContext => ({
  cwd: repo,
  workspaceRoots: [workspace],
  tempRoots: ["/tmp", tmpdir()],
  home: "/home/owner",
  git: git("feature/login", { origin: "main" }),
  ...overrides,
});
const bash = (command: string, overrides?: Partial<OwnerGuardContext>) => ownerGuard({ tool: "Bash", command }, context(overrides));

describe("the owner guard lets ordinary repository work through", () => {
  it.each([
    "git push origin main",
    "git push",
    "git push -u origin feature/login",
    "git push --force-with-lease origin feature/login",
    "git push -f",
    "git commit -am 'ship it' && git push origin HEAD:main",
    "gh pr create --fill && gh pr merge --auto --squash",
    "gh api repos/woodbeary/later-dog/pulls",
    "gh api -X DELETE repos/woodbeary/later-dog/git/refs/heads/old-branch",
    "rm -rf node_modules dist .turbo",
    "rm -rf ./*",
    "rm -rf /tmp/laterdog-build-123",
    "rm -rf $TMPDIR/scratch",
    "rm -r build 2>/dev/null || true",
    "find . -name '*.log' -delete",
    "rm notes.txt ~/old.txt",
    "pnpm build && pnpm test && pnpm release:beta",
    "cat > clean.sh <<'EOF'\nrm -rf \"$OUT\"\nrm -rf ~/\nEOF\nchmod +x clean.sh",
    "echo 'git push --force origin main'",
  ])("%s", async (command) => {
    expect(await bash(command)).toBeNull();
  });
});

describe("the owner guard refuses a force-push to the default branch", () => {
  it.each([
    "git push --force origin main",
    "git push -f origin main",
    "git push origin +main",
    "git push --force-with-lease origin HEAD:main",
    "git push -uf origin refs/heads/main",
    "git -C later-dog push --force origin main",
    "cd later-dog && git push --force origin main",
    "bash -lc 'git push --force origin main'",
    "sudo git push --mirror --force",
  ])("%s", async (command) => {
    expect((await bash(command))?.rule).toBe("force-push-default-branch");
  });

  it("follows the current branch when the push names none", async () => {
    expect((await bash("git push --force", { git: git("main", { origin: "main" }) }))?.message)
      .toBe("later.dog refused this: force-pushing main, the repository's default branch, is never allowed. Push a new branch and open a pull request instead.");
    expect(await bash("git push --force", { git: git("feature/login", { origin: "main" }) })).toBeNull();
  });

  it("uses the repository's own default branch, falling back to main and master", async () => {
    expect((await bash("git push -f origin trunk", { git: git(null, { origin: "trunk" }) }))?.rule).toBe("force-push-default-branch");
    expect(await bash("git push -f origin main", { git: git(null, { origin: "trunk" }) })).toBeNull();
    expect((await bash("git push -f origin master", { git: git(null) }))?.rule).toBe("force-push-default-branch");
  });

  it("refuses an unnamed force-push when it cannot tell the branch", async () => {
    expect((await bash("git push --force", { git: git(null) }))?.message).toMatch(/could not tell which branch/);
  });
});

describe("the owner guard refuses deleting a remote repository", () => {
  it.each([
    "gh repo delete woodbeary/later-dog --yes",
    "gh api -X DELETE repos/woodbeary/later-dog",
    "gh api --method=DELETE /repos/woodbeary/later-dog",
    "curl -X DELETE -H 'Authorization: token x' https://api.github.com/repos/woodbeary/later-dog",
    "glab repo delete group/project",
  ])("%s", async (command) => {
    expect((await bash(command))?.message).toBe("later.dog refused this: deleting a remote repository is never allowed for a dog.");
  });

  it("covers MCP and connected-app tools that delete a repository", async () => {
    for (const tool of ["mcp__github__delete_repository", "GITHUB_DELETE_A_REPOSITORY", "mcp__composio__GITHUB_DELETE_A_REPOSITORY"]) {
      expect((await ownerGuard({ tool }, context()))?.rule, tool).toBe("delete-remote-repository");
    }
    for (const tool of ["mcp__github__delete_repository_secret", "mcp__github__delete_file", "GITHUB_DELETE_A_REPOSITORY_WEBHOOK"]) {
      expect(await ownerGuard({ tool }, context()), tool).toBeNull();
    }
  });
});

describe("the owner guard refuses recursive deletes outside the workspace and /tmp", () => {
  it.each([
    ["rm -rf ~/code/old-clone", "/home/owner/code/old-clone"],
    ["rm -rf /etc/nginx", "/etc/nginx"],
    ["rm -fr ../../other-thread", "/srv/laterdog/task-workspaces/dog-1/other-thread"],
    ["rm -rf /tmp", "/tmp"],
    ["rm -rf $HOME/.ssh", "/home/owner/.ssh"],
    ["cd / && rm -rf srv", "/srv"],
    ["find /home/owner -name node_modules -delete", "/home/owner"],
  ])("%s", async (command, path) => {
    const refusal = await bash(command);
    expect(refusal?.rule).toBe("delete-outside-workspace");
    expect(refusal?.message).toBe(`later.dog refused this: it deletes ${path} recursively, outside this dog's workspace and /tmp.`);
  });

  it("names a glob as written", async () => {
    expect((await bash("rm -rf ~/*"))?.message).toBe("later.dog refused this: it deletes ~/* recursively, outside this dog's workspace and /tmp.");
  });

  it("asks for the literal path when the target is a variable it cannot see", async () => {
    expect((await bash("rm -rf \"$BUILD_DIR\"/"))?.message)
      .toBe("later.dog refused this: it deletes $BUILD_DIR/ recursively, and later.dog cannot tell where that is. Write the literal path inside this dog's workspace or /tmp.");
    expect(await bash("BUILD_DIR=dist; rm -rf dist")).toBeNull();
  });

  it("only guards shell tools", async () => {
    expect(await ownerGuard({ tool: "Write", command: "rm -rf /" }, context())).toBeNull();
    expect((await ownerGuard({ tool: "shell", command: "rm -rf /" }, context()))?.rule).toBe("delete-outside-workspace");
    expect(ownerGuardRequest("Bash", undefined, "rm -rf /")).toEqual({ tool: "Bash", command: "rm -rf /" });
    expect(ownerGuardRequest("Edit", undefined, "rm -rf /")).toEqual({ tool: "Edit", command: undefined });
  });
});

describe("the workspace roots", () => {
  it("never count the whole filesystem or the home folder as a workspace", () => {
    expect(ownerWorkspaceRoots(["/", "/home/owner", undefined, "relative/path", workspace], "/home/owner")).toEqual([workspace]);
  });
});

describe("the real git lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-guard-git-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the current branch and the remote's default branch", async () => {
    const run = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    run("init", "-q", "-b", "release-train");
    run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "--allow-empty", "-m", "start");
    run("update-ref", "refs/remotes/origin/trunk", "HEAD");
    expect(await systemGit.currentBranch(dir)).toBe("release-train");
    expect(await systemGit.defaultBranch(dir, "origin")).toBeNull();
    run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await systemGit.defaultBranch(dir, "origin")).toBe("trunk");
  });
});
