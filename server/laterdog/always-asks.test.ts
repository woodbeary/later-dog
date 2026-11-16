import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALWAYS_ASK_IDS, alwaysAskHook, alwaysAsks, connectorAlwaysAsks, internalCallRequest, type AlwaysAskId } from "./always-asks.ts";
import { defaultTempRoots, ownerGuard, type OwnerGuardContext } from "./owner-guard.ts";

const WORKSPACE = "/srv/dogs/ada/work";
const guard = (): OwnerGuardContext => ({ cwd: WORKSPACE, workspaceRoots: [WORKSPACE], tempRoots: defaultTempRoots(), home: "/home/dog", repositoryRoot: (cwd) => (cwd.startsWith(WORKSPACE) ? WORKSPACE : null) });
const shell = (command: string) => alwaysAsks({ tool: "Bash", command }, guard)?.id ?? null;
const expectAll = (id: AlwaysAskId | null, commands: readonly string[]) => {
  for (const command of commands) expect(shell(command), command).toBe(id);
};

describe("a push that skips its checks always asks", () => {
  it("asks for the plain spellings", () => {
    expectAll("push-skips-checks", [
      "git push --no-verify",
      "git push --no-verify origin atelier/what-asks",
      "git push origin HEAD --no-verify",
      "git push -u origin feature --no-verify",
      "LATERDOG_SKIP_HOOKS=1 git push",
      "git push --no-verify --force-with-lease origin feature",
    ]);
  });

  it("asks for the short forms git accepts", () => {
    expectAll("push-skips-checks", ["git push --no-veri", "git push --no-verif origin x"]);
  });

  it("sees through quotes, escapes, braces and line breaks", () => {
    expectAll("push-skips-checks", [
      "git push \"--no-verify\"",
      "git push '--no-verify'",
      "git push --no-\"ver\"ify",
      "git push --no-ver\\ify",
      "git push $'--no-verify'",
      "git p\"u\"sh --no-verify",
      "git push --no-{verify,x}",
      "git push \\\n  --no-verify origin x",
      "git push --no-\\\nverify",
    ]);
  });

  it("sees through wrappers, nested shells, pipes and here-documents", () => {
    expectAll("push-skips-checks", [
      "sudo git push --no-verify",
      "env LATERDOG_SKIP_HOOKS=1 git push",
      "nice -n 5 timeout 60 git push --no-verify",
      "bash -c 'git push --no-verify'",
      "sh -c \"cd repo && git push --no-verify\"",
      "eval git push --no-verify",
      "echo origin | xargs git push --no-verify",
      "bash <<'EOF'\ngit push --no-verify\nEOF",
      "python3 - <<'EOF'\nimport os\nos.system('git push --no-verify')\nEOF",
      "F=--no-verify; git push $F",
      "a=ver; git push --no-${a}ify",
      "git push --no-$(echo ver)ify",
      "git push --no-`echo veri`fy",
      "git push $(printf -- '-%s' -no-verify)",
      "LATERDOG_SKIP_$(echo HOOKS)=1 git push",
      "k=hooksPath; git -c core.$k=/dev/null push",
      "cd repo; git add -A && git commit -m wip && git push --no-verify",
    ]);
  });

  it("asks when the skip is set up for later", () => {
    expectAll("push-skips-checks", [
      "export LATERDOG_SKIP_HOOKS=1",
      "declare -x LATERDOG_SKIP_HOOKS=yes",
      "echo 'export LATERDOG_SKIP_HOOKS=1' >> ~/.bashrc",
      "printf -v LATERDOG_SKIP_HOOKS 1",
      "git config alias.p 'push --no-verify'",
      "git config --global alias.ship '!git push --no-verify'",
      "git -c alias.p='push --no-verify' p",
      "git config core.hooksPath /dev/null",
      "git config core.hooksPath=/dev/null",
      "git -c core.hooksPath=/dev/null push",
      "git -c CORE.HOOKSPATH=/dev/null push",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push",
      "git --config-env=core.hooksPath=EMPTY push",
      "rm .git/hooks/pre-push",
      "chmod -x scripts/git-hooks/pre-push",
      "echo 'exit 0' > scripts/git-hooks/pre-push",
      "git send-pack origin HEAD:refs/heads/x",
    ]);
  });

  it("asks when the push skips the remote checks or hides its words", () => {
    expectAll("push-skips-checks", [
      "git push -o ci.skip",
      "git push --push-option=ci.skip origin x",
      "git push $(echo LS1uby12ZXJpZnk= | base64 -d)",
      "git push $(echo yfirev-on-- | rev)",
      "git push $(printf '\\x2d\\x2dno-verify')",
    ]);
  });

  it("lets an ordinary push and ordinary hook work through", () => {
    expectAll(null, [
      "git push",
      "git push -u origin atelier/what-asks",
      "git push --force-with-lease origin feature",
      "git push -n origin feature",
      "git push origin $(git rev-parse --abbrev-ref HEAD)",
      "git commit --no-verify -m wip",
      "git config --get core.hooksPath",
      "git config core.hooksPath",
      "git config --unset core.hooksPath",
      "echo $LATERDOG_SKIP_HOOKS",
      "unset LATERDOG_SKIP_HOOKS && git push",
      "cat scripts/git-hooks/pre-push",
      "grep -n no-verify docs/notes.md",
      "pnpm test",
    ]);
  });
});

describe("making a sign-in key or client in a cloud account always asks", () => {
  it("asks for the commands that mint keys and clients", () => {
    expectAll("cloud-credential", [
      "gcloud iam service-accounts keys create key.json --iam-account=bot@p.iam.gserviceaccount.com",
      "gcloud alpha iap oauth-clients create projects/p/brands/1 --display_name=x",
      "gcloud services api-keys create --display-name=x",
      "gcloud storage hmac create bot@p.iam.gserviceaccount.com",
      "aws iam create-access-key --user-name bot",
      "aws --profile work iam create-login-profile --user-name bot --password x",
      "aws cognito-idp create-user-pool-client --user-pool-id p --client-name x",
      "aws ec2 create-key-pair --key-name x",
      "az ad sp create-for-rbac --name x",
      "az ad app credential reset --id 1",
      "gh ssh-key add ~/.ssh/id.pub",
      "gh api -X POST user/keys -f key=x",
      "gh api user/keys --method POST -f title=x",
      "sudo gcloud iam service-accounts keys create k.json --iam-account=a",
      "bash -c 'aws iam create-access-key'",
      "GCLOUD=gcloud; $GCLOUD iam service-accounts \"keys\" create k.json",
    ]);
  });

  it("asks for opening a console's keys or sign-in client page, however the address is written", () => {
    for (const url of [
      "https://console.cloud.google.com/apis/credentials?project=p",
      "https://console.cloud.google.com/auth/clients/create?project=p",
      "https://console.cloud.google.com/iam-admin/serviceaccounts?project=p",
      "https://CONSOLE.cloud.google.com/apis/%63redentials",
      "https://console.cloud.google.com//apis//credentials",
      "https://console.developers.google.com/apis/credentials",
      "https://console.aws.amazon.com/iam/home#/security_credentials",
      "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      "https://github.com/settings/tokens/new",
      "https://github.com/settings/apps/new",
      "https://dash.cloudflare.com/profile/api-tokens",
    ]) {
      expect(alwaysAsks({ tool: "mcp__computer__open_url", summary: url }, guard)?.id, url).toBe("cloud-credential");
      expect(alwaysAsks({ tool: "mcp__browser__navigate", summary: url }, guard)?.id, url).toBe("cloud-credential");
      expect(shell(`xdg-open '${url}'`), url).toBe("cloud-credential");
    }
  });

  it("lets reading and ordinary pages through", () => {
    expectAll(null, [
      "gcloud iam service-accounts keys list --iam-account=a",
      "aws iam list-access-keys",
      "gh ssh-key list",
      "gh api user/keys",
      "gcloud compute instances create vm-1",
    ]);
    for (const url of ["https://console.cloud.google.com/home/dashboard", "https://github.com/woodbeary/later-dog/pulls", "https://example.com/apis/credentials"]) {
      expect(alwaysAsks({ tool: "mcp__computer__open_url", summary: url }, guard), url).toBeNull();
    }
    expect(alwaysAsks({ tool: "Edit", summary: "notes.md: https://console.cloud.google.com/apis/credentials" }, guard)).toBeNull();
  });
});

describe("deleting outside the dog's own folders always asks", () => {
  it("asks in every spelling the owner guard already knows", () => {
    expectAll("delete-outside-workspace", [
      "rm -rf /srv/dogs/other",
      "rm -r -f ~/Documents",
      "sudo rm -rf /etc/later",
      "cd / && rm -rf srv",
      "bash -c 'rm -rf /var/lib/x'",
      "find /srv/dogs -name '*.log' -delete",
      "rm -rf $SOMEWHERE",
    ]);
  });

  it("carries the path in the card", () => {
    expect(alwaysAsks({ tool: "Bash", command: "rm -rf /srv/dogs/other" }, guard)?.ask).toContain("/srv/dogs/other");
  });

  it("lets deletes inside the workspace and /tmp through", () => {
    expectAll(null, ["rm -rf build", "rm -rf /srv/dogs/ada/work/dist", "rm -rf /tmp/scratch", "rm notes.txt"]);
  });
});

describe("sending or paying from a connected app always asks", () => {
  it("names the send and the payment apart", () => {
    expect(connectorAlwaysAsks(["GMAIL_SEND_EMAIL"])?.id).toBe("sends-for-you");
    expect(connectorAlwaysAsks(["SLACK_SEND_MESSAGE", "STRIPE_CREATE_REFUND"])?.id).toBe("pays");
    expect(connectorAlwaysAsks(["STRIPE_CREATE_PAYMENT_INTENT"])?.id).toBe("pays");
    expect(connectorAlwaysAsks(["PAYPAL_CREATE_PAYOUT"])?.id).toBe("pays");
    expect(connectorAlwaysAsks(["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"])).toBeNull();
    expect(connectorAlwaysAsks(["GITHUB_CREATE_AN_ISSUE_COMMENT"])).toBeNull();
  });

  it("asks for an engine tool that sends or pays", () => {
    expect(alwaysAsks({ tool: "mcp__mail__send_email" }, guard)?.id).toBe("sends-for-you");
    expect(alwaysAsks({ tool: "mcp__shop__chargeCard" }, guard)?.id).toBe("pays");
    expect(alwaysAsks({ tool: "mcp__mail__list_messages" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "mcp__github__add_issue_comment" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "mcp__github__create_payment" }, guard)?.id).toBe("pays");
  });
});

describe("the list", () => {
  it("is closed and every rule has words for the card", () => {
    expect(ALWAYS_ASK_IDS).toEqual(["push-skips-checks", "cloud-credential", "delete-outside-workspace", "sends-for-you", "pays"]);
    expect(alwaysAsks({ tool: "Bash", command: "git push --no-verify" }, guard)?.ask).toMatch(/pushes code without running its checks.*always asks you/);
    expect(alwaysAsks({ tool: "Bash", command: "git push --no-verify" }, guard)?.refusal).toMatch(/^later\.dog did not run this/);
  });

  it("answers the engine's hook with ask, for shell commands and opened pages", () => {
    expect(alwaysAskHook({ tool_name: "Bash", tool_input: { command: "git push --no-verify" } }, guard)).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" });
    expect(alwaysAskHook({ tool_name: "mcp__computer__open_url", tool_input: { url: "https://console.cloud.google.com/apis/credentials" } }, guard)).toMatchObject({ permissionDecision: "ask" });
    expect(alwaysAskHook({ tool_name: "Bash", tool_input: { command: "git push" } }, guard)).toBeNull();
    expect(alwaysAskHook({ tool_name: "Read", tool_input: { file_path: "/x" } }, guard)).toBeNull();
  });
});

type Row = [label: string, request: { tool: string; command?: string; summary?: string; input?: Record<string, unknown> }, expected: AlwaysAskId | null];

const bash = (command: string): Row[1] => ({ tool: "Bash", command });
const via = (tool: string, input: Record<string, unknown>): Row[1] => ({ tool, input });

const REVIEW_ROWS: Row[] = [
  ["push: hooks path by -c", bash("git -c core.hooksPath=/dev/null push"), "push-skips-checks"],
  ["push: a variable this repository's hook never reads", bash("HUSKY=0 git push"), null],
  ["push: short form", bash("git push --no-verif"), "push-skips-checks"],
  ["push: skipping only the commit hook", bash("git commit -n -m wip && git push"), null],
  ["push: empty command substitution inside the word", bash("git push --no-ver$(true)ify origin x"), "push-skips-checks"],
  ["push: unset variable inside the word", bash("git push --no-ver${UNSET}ify origin x"), "push-skips-checks"],
  ["push: empty $@ inside the word", bash("git push --no-ver$@ify origin x"), "push-skips-checks"],
  ["push: git-push from the exec path", bash("\"$(git --exec-path)\"/git-push --no-verify origin x"), "push-skips-checks"],
  ["push: git-push by full path", bash("/usr/lib/git-core/git-push --no-verify origin x"), "push-skips-checks"],
  ["push: alias", bash("alias gp='git push --no-verify'; gp"), "push-skips-checks"],
  ["push: function", bash("g(){ git \"$@\"; }; g push --no-verify"), "push-skips-checks"],
  ["push: eval", bash("eval \"git push --no-$(echo verify)\""), "push-skips-checks"],
  ["push: decoded text into a shell", bash("echo Z2l0IHB1c2ggLS1uby12ZXJpZnk= | base64 -d | sh"), "push-skips-checks"],
  ["push: script written and run", bash("printf 'git push --no-verify' > /tmp/p.sh && sh /tmp/p.sh"), "push-skips-checks"],
  ["push: a script file written in an earlier call", bash("sh /tmp/p.sh"), null],
  ["push: hooks folder moved", bash("mv scripts/git-hooks scripts/git-hooks.off && git push"), "push-skips-checks"],
  ["push: hooks folder removed", bash("rm -rf scripts/git-hooks && git push"), "push-skips-checks"],
  ["push: hooks path by config", bash("git config core.hooksPath .nohooks && git push"), "push-skips-checks"],
  ["push: a branch moved through the API", bash("gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0123abc"), "push-skips-checks"],
  ["push: an option kept for later", bash("export GITOPT=--no-verify"), null],
  ["push: an option from a variable", bash("git push $GITOPT origin x"), "push-skips-checks"],
  ["push: option through xargs", bash("echo --no-verify | xargs git push"), "push-skips-checks"],
  ["push: the shell tool", { tool: "shell", command: "git push --no-verify" }, "push-skips-checks"],
  ["push: run_on_computer", via("mcp__agents__run_on_computer", { command: "git push --no-verify" }), "push-skips-checks"],
  ["push: cloud computer exec", via("mcp__computer__exec", { command: "git push --no-verify" }), "push-skips-checks"],
  ["push: the lent Mac", via("mcp__agents__shared_computer", { action: "run_command", command: "git push --no-verify" }), "push-skips-checks"],
  ["push: Write on the hook file", via("Write", { file_path: "scripts/git-hooks/pre-push", content: "exit 0" }), "push-skips-checks"],
  ["push: Edit on the hook file", via("Edit", { file_path: "/srv/dogs/ada/work/scripts/git-hooks/pre-push" }), "push-skips-checks"],
  ["push: the lent Mac writing a hook", via("mcp__agents__shared_computer", { action: "write_file", path: "code/app/.husky/pre-push" }), "push-skips-checks"],
  ["credential: gcloud key", bash("gcloud iam service-accounts keys create k.json --iam-account x@p.iam.gserviceaccount.com"), "cloud-credential"],
  ["credential: aws key", bash("aws --profile x iam create-access-key --user-name bot"), "cloud-credential"],
  ["credential: gh api key", bash("gh api user/keys --method POST -f title=x -f key=\"$(cat k.pub)\""), "cloud-credential"],
  ["credential: curl GitHub key", bash("curl -X POST -H \"Authorization: token $T\" https://api.github.com/user/keys -d @k.json"), "cloud-credential"],
  ["credential: curl Cloudflare token", bash("curl -X POST https://api.cloudflare.com/client/v4/user/tokens -H \"Authorization: Bearer $CF\" -d @t.json"), "cloud-credential"],
  ["credential: flyctl token", bash("flyctl tokens create deploy"), "cloud-credential"],
  ["credential: run_on_computer", via("mcp__agents__run_on_computer", { command: "gcloud iam service-accounts keys create k.json" }), "cloud-credential"],
  ["credential: open_url console", { tool: "mcp__computer__open_url", summary: "https://console.cloud.google.com/apis/credentials" }, "cloud-credential"],
  ["credential: browser navigate console", { tool: "mcp__browser__navigate", summary: "https://console.cloud.google.com/apis/credentials" }, "cloud-credential"],
  ["credential: app passwords", { tool: "mcp__computer__open_url", summary: "https://myaccount.google.com/apppasswords" }, "cloud-credential"],
  ["credential: GitHub new token", { tool: "mcp__computer__open_url", summary: "https://github.com/settings/tokens/new" }, "cloud-credential"],
  ["delete: rm -rf outside", bash("rm -rf /srv/dogs/other"), "delete-outside-workspace"],
  ["delete: rsync --delete", bash("rsync -a --delete /tmp/empty/ /srv/dogs/other/"), "delete-outside-workspace"],
  ["delete: git -C clean", bash("git -C /srv/dogs/other clean -fdx"), "delete-outside-workspace"],
  ["delete: cd then git clean", bash("cd /srv/dogs/other && git clean -fdx"), "delete-outside-workspace"],
  ["delete: a symlink made in the same command", bash("ln -s /srv/dogs/other link && rm -rf link/*"), "delete-outside-workspace"],
  ["delete: a symlink that does not exist here", bash("rm -rf link/"), null],
  ["delete: parent folder", bash("rm -rf ../other"), "delete-outside-workspace"],
  ["delete: through ..", bash("rm -rf /srv/dogs/ada/work/../../other"), "delete-outside-workspace"],
  ["delete: echo into xargs rm", bash("echo /srv/dogs/other | xargs rm -rf"), "delete-outside-workspace"],
  ["delete: find into xargs rm", bash("find /srv/dogs/other -type f | xargs rm"), "delete-outside-workspace"],
  ["delete: find -exec rm", bash("find /srv/dogs/other -exec rm -rf {} +"), "delete-outside-workspace"],
  ["delete: inline python", bash("python3 -c \"import shutil; shutil.rmtree('/srv/dogs/other')\""), "delete-outside-workspace"],
  ["delete: inline perl", bash("perl -e 'unlink glob \"/srv/dogs/other/*\"'"), "delete-outside-workspace"],
  ["delete: one file in the home folder", bash("rm ~/Documents/report.pdf"), "delete-outside-workspace"],
  ["delete: one file outside", bash("rm /srv/dogs/other/notes.txt"), "delete-outside-workspace"],
  ["delete: unlink", bash("unlink /srv/dogs/other/notes.txt"), "delete-outside-workspace"],
  ["delete: shred -u", bash("shred -u /srv/dogs/other/notes.txt"), "delete-outside-workspace"],
  ["delete: moved to /tmp then removed", bash("mv /srv/dogs/other /tmp/gone && rm -rf /tmp/gone"), "delete-outside-workspace"],
  ["delete: on the dog's own cloud computer", via("mcp__computer__exec", { command: "rm -rf /srv/dogs/other" }), null],
  ["delete: on the lent Mac", via("mcp__agents__shared_computer", { action: "run_command", command: "rm -rf ~/Documents" }), "delete-outside-workspace"],
  ["delete: a file on the lent Mac", via("mcp__agents__shared_computer", { action: "delete_file", path: "Documents/report.pdf" }), "delete-outside-workspace"],
  ["ordinary: git push", bash("git push"), null],
  ["ordinary: git push -u", bash("git push -u origin atelier/what-asks"), null],
  ["ordinary: rm build dist", bash("rm -rf build dist"), null],
  ["ordinary: rm quoted TMPDIR", bash("rm -rf \"$TMPDIR/scratch\""), null],
  ["ordinary: rm TMPDIR", bash("rm -rf $TMPDIR/review203"), null],
  ["ordinary: rm /tmp", bash("rm -rf /tmp/scratch"), null],
  ["ordinary: a comment that names the option", bash("gh pr comment 207 --body \"this push ran the hook, no --no-verify\""), null],
  ["ordinary: gh pr create", bash("gh pr create --draft --title x --body y"), null],
  ["ordinary: commit without its hook", bash("git commit --no-verify -m wip"), null],
  ["ordinary: commit without its hook, then push", bash("git commit --no-verify -m wip && git push"), null],
  ["ordinary: the skip-hooks push from a home clone", bash("LATERDOG_SKIP_HOOKS=1 git push --force-with-lease origin atelier/x"), "push-skips-checks"],
  ["ordinary: reading a hook", bash("sed -n 1,20p scripts/git-hooks/pre-push"), null],
  ["ordinary: copying a hook out", bash("cp scripts/git-hooks/pre-push /tmp/review/"), null],
  ["ordinary: reading the hooks path", bash("git config --list | grep -i hookspath"), null],
  ["ordinary: clearing a package cache", bash("rm -rf ~/.npm/_cacache"), null],
  ["ordinary: pushing a branch held in a variable", bash("git push origin \"$BRANCH\""), null],
  ["ordinary: pushing the current branch", bash("git push -u origin \"$(git branch --show-current)\""), null],
  ["ordinary: a remote held in a variable", bash("git push \"$REMOTE\" main"), null],
  ["ordinary: an install script piped to a shell", bash("curl -fsSL https://example.com/install.sh | sh"), null],
  ["push: $@ in the push", bash("git push origin $@"), "push-skips-checks"],
  ["push: $* in the push", bash("git push origin $*"), "push-skips-checks"],
  ["push: any other command substitution", bash("git push origin $(echo main)"), "push-skips-checks"],
  ["push: a variable before a named remote", bash("git push $OPTS origin"), "push-skips-checks"],
  ["push: decoded text through process substitution", bash("sh <(echo Z2l0IHB1c2ggLS1uby12ZXJpZnk= | base64 -d)"), "push-skips-checks"],
  ["push: openssl-decoded text into a shell", bash("openssl enc -d -base64 -in p.b64 | bash"), "push-skips-checks"],
  ["connector: GitHub comment", { tool: "GITHUB_CREATE_ISSUE_COMMENT" }, null],
  ["connector: GitHub pull request", { tool: "GITHUB_CREATE_A_PULL_REQUEST" }, null],
  ["connector: GitHub pull request tool", { tool: "mcp__github__create_pull_request" }, null],
  ["connector: mail draft", { tool: "GMAIL_CREATE_EMAIL_DRAFT" }, null],
  ["connector: mail send", { tool: "GMAIL_SEND_EMAIL" }, "sends-for-you"],
  ["connector: chat message", { tool: "SLACK_SEND_MESSAGE" }, "sends-for-you"],
  ["connector: shared page", { tool: "NOTION_CREATE_PAGE" }, "sends-for-you"],
  ["connector: calendar invitation", { tool: "GOOGLECALENDAR_CREATE_EVENT" }, "sends-for-you"],
  ["connector: reading payments", { tool: "STRIPE_LIST_PAYMENTS" }, null],
  ["connector: shared issue", { tool: "LINEAR_CREATE_ISSUE" }, "sends-for-you"],
];

describe("the independent review's inputs", () => {
  it.each(REVIEW_ROWS)("%s", (_label, request, expected) => {
    expect(alwaysAsks(request, guard)?.id ?? null).toBe(expected);
  });

  it("counts one ordinary command that asks, the skip-hooks push", () => {
    const ordinary = REVIEW_ROWS.filter(([label]) => label.startsWith("ordinary:"));
    expect(ordinary).toHaveLength(19);
    expect(ordinary.filter(([, request]) => alwaysAsks(request, guard)).map(([label]) => label)).toEqual(["ordinary: the skip-hooks push from a home clone"]);
  });

  it("answers the engine's hook with ask for each guarded tool", () => {
    const payload = { command: "git push --no-verify", url: "https://console.cloud.google.com/apis/credentials" };
    for (const tool of ["Bash", "mcp__computer__exec", "mcp__agents__run_on_computer", "mcp__browser__navigate", "mcp__computer__open_url"]) {
      expect(alwaysAskHook({ tool_name: tool, tool_input: payload }, guard)?.permissionDecision, tool).toBe("ask");
    }
    expect(alwaysAskHook({ tool_name: "Write", tool_input: { file_path: ".git/hooks/pre-push", content: "exit 0" } }, guard)?.permissionDecision).toBe("ask");
    expect(alwaysAskHook({ tool_name: "Write", tool_input: { file_path: "src/app.ts", content: "x" } }, guard)).toBeNull();
  });

  it("says plainly when it asks because it cannot read the command", () => {
    expect(alwaysAsks(bash("git push $GITOPT origin x"), guard)?.ask).toMatch(/^This runs text later\.dog cannot read/);
    expect(alwaysAsks(bash("git push --no-verify"), guard)?.ask).toMatch(/^This pushes code without running its checks\./);
  });
});

describe("what later.dog's own endpoints hand to the list", () => {
  it("reads the cloud computer, the browser, run_on_computer and the lent Mac", () => {
    const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const cases: Array<[string, unknown, AlwaysAskId | null]> = [
      ["/api/internal/computer/mcp", call("exec", { command: "git push --no-verify" }), "push-skips-checks"],
      ["/api/internal/computer/mcp", call("open_url", { url: "https://console.cloud.google.com/apis/credentials" }), "cloud-credential"],
      ["/api/internal/computer/mcp", call("screenshot", {}), null],
      ["/api/internal/browser/mcp", call("agent_browser_navigate", { url: "https://github.com/settings/tokens/new" }), "cloud-credential"],
      ["/api/internal/browser/mcp", { method: "tools/list" }, null],
      ["/api/internal/computer-run", { command: "aws iam create-access-key" }, "cloud-credential"],
      ["/api/internal/shared-computers", { action: "run_command", command: "rm -rf ~/Documents/old" }, "delete-outside-workspace"],
      ["/api/internal/shared-computers", { action: "read_file", path: "notes.md" }, null],
    ];
    for (const [path, body, expected] of cases) {
      const request = internalCallRequest(path, body);
      expect(request ? alwaysAsks(request, guard)?.id ?? null : null, `${path} ${JSON.stringify(body)}`).toBe(expected);
    }
  });
});

describe("a delete through a real symlink", () => {
  it("follows the link to where the files really are", () => {
    const root = mkdtempSync(join(tmpdir(), "always-asks-"));
    try {
      const work = join(root, "work");
      const other = join(root, "other");
      mkdirSync(work);
      mkdirSync(other);
      symlinkSync(other, join(work, "link"));
      const real = (): OwnerGuardContext => ({ cwd: work, workspaceRoots: [work], tempRoots: [join(root, "tmp")], home: join(root, "home") });
      const id = (command: string) => alwaysAsks({ tool: "Bash", command }, real)?.id ?? null;
      expect(id("rm -rf link/")).toBe("delete-outside-workspace");
      expect(id("rm -rf link/*")).toBe("delete-outside-workspace");
      expect(id("rm link")).toBeNull();
      expect(id("rm -rf ./build")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a push whose output is kept", () => {
  it.each([
    "out=$(git push --no-verify 2>&1); echo \"$out\"",
    "result=`git push --no-verify origin x`",
    "[ -n \"$(git push --no-verify 2>&1)\" ]",
    "echo $(git push --no-verify)",
    "echo \"pushed: $(cd repo && git push --no-verify origin x)\"",
    "x=$(echo $(git push --no-verify))",
    "key=$(gcloud iam service-accounts keys create k.json --iam-account=a)",
  ])("%s asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).not.toBeNull();
  });

  it("still lets an ordinary captured push through", () => {
    expect(alwaysAsks({ tool: "Bash", command: "out=$(git push origin x 2>&1); echo \"$out\"" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "Bash", command: "echo $((1 + 2))" }, guard)).toBeNull();
  });
});

describe("moving a branch through the API", () => {
  it.each([
    "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0123abc -F force=true",
    "gh api -X PATCH repos/o/r/git/refs/heads/feature -f sha=0123abc",
    "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=0123abc",
    "gh api --method PUT repos/o/r/contents/src/app.ts -f message=fix -f content=eA==",
    "curl -X POST https://api.github.com/repos/o/r/git/refs -d @ref.json",
    "curl -X PATCH -H \"Authorization: token $T\" https://api.github.com/repos/o/r/git/refs/heads/main -d '{\"sha\":\"0\"}'",
    "glab api -X POST projects/42/repository/branches -f branch=x -f ref=main",
    "curl -X POST https://gitlab.com/api/v4/projects/42/repository/commits -d @c.json",
    "curl -X POST https://api.bitbucket.org/2.0/repositories/o/r/refs/branches -d @b.json",
  ])("%s asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)?.id).toBe("push-skips-checks");
  });

  it.each([
    "gh api repos/o/r/git/refs/heads/main",
    "gh api -X DELETE repos/o/r/git/refs/heads/old-branch",
    "gh api -X PATCH repos/woodbeary/later-dog/pulls/201 -F body=@notes/pr-body.md",
    "curl https://api.github.com/repos/o/r/git/refs/heads/main",
  ])("%s does not", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).toBeNull();
  });
});

describe("text assigned earlier in the same command", () => {
  it.each([
    "B=--no-verify; git push origin \"$B\"",
    "B=--no-verify && git push origin ${B}",
    "export OPT=--no-verify; git push origin $OPT",
    "CMD='git push --no-verify'; eval \"$CMD\"",
    "CMD='git push --no-verify'; sh -c \"$CMD\"",
    "K='gcloud iam service-accounts keys create k.json'; eval \"$K\"",
    "D=/srv/dogs/other; rm -rf \"$D\"",
  ])("%s asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).not.toBeNull();
  });

  it("still reads a value from an earlier call as a branch name, as decided", () => {
    expect(alwaysAsks({ tool: "Bash", command: "git push origin \"$B\"" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "Bash", command: "B=feature/login; git push origin \"$B\"" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "Bash", command: "OUT=dist; rm -rf \"$OUT\"" }, guard)).toBeNull();
  });
});

describe("text typed into a command running on the lent Mac", () => {
  it("is read like a command", () => {
    const typed = (input: string) => {
      const request = internalCallRequest("/api/internal/shared-computers", { action: "command_input", command_id: "c1", input });
      return request ? alwaysAsks(request, guard)?.id ?? null : null;
    };
    expect(typed("git push --no-verify\n")).toBe("push-skips-checks");
    expect(typed("rm -rf ~/Documents/old\n")).toBe("delete-outside-workspace");
    expect(typed("y\n")).toBeNull();
  });
});

const internalRow = (path: string, body: unknown): Row[1] => internalCallRequest(path, body) ?? { tool: "none" };
const call2 = (name: string, args: Record<string, unknown>) => ({ method: "tools/call", params: { name, arguments: args } });

const SECOND_ORDINARY: Row[] = [
  ...[
    "git fetch origin && git rebase origin/main",
    "git push --force-with-lease origin atelier/x",
    "git push origin HEAD",
    "git push -u origin \"$(git branch --show-current)\"",
    "git commit -am 'Fix the card' && git push origin HEAD:refs/heads/atelier/x",
    "git stash && git pull --rebase && git stash pop",
    "git branch -D old && git push origin --delete old",
    "pnpm install --frozen-lockfile",
    "pnpm exec vitest run server/laterdog/always-asks.test.ts",
    "pnpm store prune",
    "rm -rf \"$TMPDIR\"/build-*",
    "rm -rf /srv/dogs/ada/work/node_modules dist",
    "rm -rf ~/.cache/pnpm ~/.npm/_logs",
    "rm -rf /tmp/laterdog-test-123",
    "find . -name '*.log' -mtime +3 -delete",
    "git clean -fdx -e .env",
    "rsync -a --exclude node_modules ./ /tmp/scratch/copy/",
    "mv notes/old.md notes/archive/old.md",
    "gh pr create --draft --title 'Fix the card' --body-file notes/body.md",
    "gh api -X PATCH repos/woodbeary/later-dog/pulls/201 -F body=@notes/pr-body.md",
    "gh pr review 207 --comment --body-file notes/review.md",
    "curl -fsSL -o /tmp/tool.tar.gz https://github.com/o/r/releases/download/v1/tool.tar.gz && tar -xzf /tmp/tool.tar.gz -C /tmp/tool",
    "git worktree add /tmp/wt main && git -C /tmp/wt log -1",
    "cat .git/hooks/pre-push.sample && ls -la .husky",
    "cp -r scripts/git-hooks /tmp/review/",
  ].map((command): Row => [`ordinary: ${command}`, bash(command), null]),
  ["ordinary by design: xargs -a … rm -f", bash("xargs -a /tmp/old-files.txt rm -f"), "delete-outside-workspace"],
  ["ordinary: Write src/app.ts", via("Write", { file_path: "/srv/dogs/ada/work/src/app.ts" }), null],
  ["ordinary by design: Edit .husky/pre-commit", via("Edit", { file_path: "/srv/dogs/ada/work/.husky/pre-commit" }), "push-skips-checks"],
  ["ordinary: run_on_computer rm -rf node_modules dist && pnpm build", internalRow("/api/internal/computer-run", { command: "rm -rf node_modules dist && pnpm build" }), null],
  ["ordinary: lent Mac ls ~/Downloads", internalRow("/api/internal/shared-computers", { action: "run_command", command: "ls ~/Downloads" }), null],
  ["ordinary by design: lent Mac rm -rf node_modules", internalRow("/api/internal/shared-computers", { action: "run_command", command: "rm -rf node_modules", cwd: "~/code/app" }), "delete-outside-workspace"],
  ["ordinary: browser to a pull request", internalRow("/api/internal/browser/mcp", call2("navigate", { url: "https://github.com/woodbeary/later-dog/pull/207" })), null],
];

const KNOWN_PUSH_PASSES = new Set([
  "env -S 'git push --no-verify'",
  "bash <<< 'git push --no-verify'",
  "git config --file .git/config core.hooksPath /dev/null && git push",
  "git config -f .git/config core.hooksPath /dev/null",
  "dd if=/dev/null of=scripts/git-hooks/pre-push && git push",
  "python3 -c \"open('scripts/git-hooks/pre-push','w').write('exit 0')\" && git push",
  "GIT_CONFIG_GLOBAL=/tmp/g git push",
  "git push origin \"$X\"",
]);

const SECOND_PUSH: Row[] = [
  "command git push --no-verify", "\\git push --no-verify", "'git' push --no-verify", "g\\it push --no-verify",
  "builtin command git push --no-verify", "env -i PATH=$PATH git push --no-verify", "env -S 'git push --no-verify'",
  "nohup git push --no-verify &", "time git push --no-verify", "sudo -u dog git push --no-verify", "exec git push --no-verify",
  "stdbuf -o0 git push --no-verify", "(git push --no-verify)", "{ git push --no-verify; }", "echo $(git push --no-verify)",
  "echo `git push --no-verify`", "true && git push --no-verify || true", "git push $'\\x2d-no-verify'", "git push $'--no-verify'",
  "git push --no-ver\"ify\"", "git \\\n push \\\n --no-verify", "bash <<EOF\ngit push --no-verify\nEOF", "bash <<< 'git push --no-verify'",
  "sh -s <<'X'\ngit push --no-verify\nX", "echo 'git push --no-verify' | sh", "printf '%s\\n' 'git push --no-verify' | bash",
  "CMD='git push --no-verify'; eval \"$CMD\"", "CMD='git push --no-verify'; sh -c \"$CMD\"", "g(){ git push \"$@\"; }; g --no-verify",
  "git config --file .git/config core.hooksPath /dev/null && git push", "git config -f .git/config core.hooksPath /dev/null",
  "git config --local core.hooksPath /dev/null", "printf 'exit 0\\n' > scripts/git-hooks/pre-push && git push",
  "cat > .git/hooks/pre-push <<EOF\nexit 0\nEOF\ngit push", ": > scripts/git-hooks/pre-push && git push",
  "dd if=/dev/null of=scripts/git-hooks/pre-push && git push", "ln -sf /bin/true scripts/git-hooks/pre-push && git push",
  "python3 -c \"open('scripts/git-hooks/pre-push','w').write('exit 0')\" && git push", "GIT_CONFIG_GLOBAL=/tmp/g git push",
  "git -C /srv/dogs/other push --no-verify", "git push origin \"$X\"",
].map((command): Row => [`hostile push: ${command}`, bash(command), KNOWN_PUSH_PASSES.has(command) ? null : "push-skips-checks"]);

const SECOND_DELETE: Row[] = [
  "command rm -rf /srv/dogs/other", "\\rm -rf /srv/dogs/other", "nohup rm -rf /srv/dogs/other &", "(cd /srv/dogs && rm -rf other)",
  "rm -rf -- /srv/dogs/other", "rm -rf \"/srv/dogs/\"other", "rm -rf /srv/dogs/oth*", "cd ..; cd ..; rm -rf other",
  "pushd /srv/dogs && rm -rf other", "rm -rf $(dirname $PWD)/other", "rm -rf \"$HOME/Documents\"", "rsync -a --delete-after /tmp/e/ /srv/dogs/other/",
  "rsync -a --remove-source-files /srv/dogs/other/ /tmp/x/", "tar --remove-files -cf /tmp/x.tar /srv/dogs/other", "mv /srv/dogs/other/* /tmp/gone/",
  "node -e \"require('fs').rmSync('/srv/dogs/other',{recursive:true})\"", "ruby -e 'require \"fileutils\"; FileUtils.rm_rf(\"/srv/dogs/other\")'",
  "perl -MFile::Path -e 'rmtree(\"/srv/dogs/other\")'", "find / -maxdepth 2 -path /srv/dogs -prune -o -name other -exec rm -rf {} \\;",
  "bash <<EOF\nrm -rf /srv/dogs/other\nEOF", "sudo -u dog rm -rf /srv/dogs/other",
].map((command): Row => [`hostile delete: ${command}`, bash(command), command.startsWith("tar --remove-files") ? null : "delete-outside-workspace"]);

const SECOND_PATHS: Row[] = [
  ["path: computer exec push", internalRow("/api/internal/computer/mcp", call2("exec", { command: "git push --no-verify" })), "push-skips-checks"],
  ["path: run_on_computer push", internalRow("/api/internal/computer-run", { command: "git push --no-verify" }), "push-skips-checks"],
  ["path: lent Mac push", internalRow("/api/internal/shared-computers", { action: "run_command", command: "git push --no-verify" }), "push-skips-checks"],
  ["path: lent Mac rm -rf ~/Documents", internalRow("/api/internal/shared-computers", { action: "run_command", command: "rm -rf ~/Documents" }), "delete-outside-workspace"],
  ["path: lent Mac delete_file", internalRow("/api/internal/shared-computers", { action: "delete_file", path: "~/Documents/a.pdf" }), "delete-outside-workspace"],
  ["path: lent Mac command_input", internalRow("/api/internal/shared-computers", { action: "command_input", command_id: "c1", input: "git push --no-verify\n" }), "push-skips-checks"],
  ["path: lent Mac write_file to a hook", internalRow("/api/internal/shared-computers", { action: "write_file", path: "~/code/app/.git/hooks/pre-push", content: "exit 0" }), "push-skips-checks"],
  ["path: browser to the console keys page", internalRow("/api/internal/browser/mcp", call2("navigate", { url: "https://console.cloud.google.com/apis/credentials" })), "cloud-credential"],
  ["path: open_url to a new GitHub token", internalRow("/api/internal/computer/mcp", call2("open_url", { url: "https://github.com/settings/tokens/new" })), "cloud-credential"],
  ["path: typing into a terminal on the cloud computer", internalRow("/api/internal/computer/mcp", call2("type_text", { text: "git push --no-verify\n" })), null],
];

const FOLLOW_UPS: Row[] = [
  ...[
    "out=$(git push --no-verify 2>&1); echo \"$out\"", "git push --no-verify 2>&1 | tee push.log", "if git push --no-verify; then echo ok; fi",
    "for b in a b; do git push --no-verify origin $b; done", "while read b; do git push --no-verify origin \"$b\"; done < /tmp/branches",
    "git push --no-verify && gh pr create --fill", "result=`git push --no-verify origin x`", "[ -n \"$(git push --no-verify 2>&1)\" ]",
    "git push --no-verify origin x > /tmp/push.log 2>&1 &", "timeout 120 git push --no-verify origin x",
    "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0123abc -F force=true", "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=0123abc",
  ].map((command): Row => [`follow-up: ${command}`, bash(command), "push-skips-checks"]),
  ["follow-up: tar --remove-files", bash("tar --remove-files -czf /tmp/old.tgz ~/old-project"), null],
  ...[
    "find . -name '*.log' -mtime +3 -delete", "find logs -name '*.log' -delete", "find ./logs -type f -delete", "find \"$PWD\" -name '*.log' -delete",
    "git clean -fdx -e .env", "git clean -fd", "git clean -n", "rm -rf ./logs", "rm -rf logs/old", "rm -rf link/", "rm -rf link/*",
  ].map((command): Row => [`root cleanup: ${command}`, bash(command), null]),
  ["root cleanup by design: xargs -a", bash("xargs -a /tmp/old-files.txt rm -f"), "delete-outside-workspace"],
  ["root cleanup by design: ls | xargs rm", bash("ls logs | xargs -I{} rm logs/{}"), "delete-outside-workspace"],
];

describe("the second review's inputs", () => {
  const all = [...SECOND_ORDINARY, ...SECOND_PUSH, ...SECOND_DELETE, ...SECOND_PATHS, ...FOLLOW_UPS];

  it.each(all)("%s", (_label, request, expected) => {
    expect(alwaysAsks(request, guard)?.id ?? null).toBe(expected);
  });

  it("counts the cards over both ordinary tables: the skip-hooks push and three by design", () => {
    const first = REVIEW_ROWS.filter(([label]) => label.startsWith("ordinary"));
    const asked = [...first, ...SECOND_ORDINARY].filter(([, request]) => alwaysAsks(request, guard)).map(([label]) => label);
    expect(first.length + SECOND_ORDINARY.length).toBe(51);
    expect(asked).toEqual([
      "ordinary: the skip-hooks push from a home clone",
      "ordinary by design: xargs -a … rm -f",
      "ordinary by design: Edit .husky/pre-commit",
      "ordinary by design: lent Mac rm -rf node_modules",
    ]);
  });
});

describe("ordinary substitutions that resolve to the dog's own places", () => {
  it.each([
    "tmp=$(mktemp -d) && cp -r dist \"$tmp\" && rm -rf \"$tmp\"",
    "ver=$(node -p \"require('./package.json').version\"); git tag \"v$ver\" && git push origin \"v$ver\"",
    "find \"$(pwd)/logs\" -name '*.log' -delete",
    "rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"",
    "git push origin \"atelier/$name\"",
  ])("%s does not ask", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).toBeNull();
  });

  it.each([
    "tmp=$(mktemp -d -p /srv/dogs) && rm -rf \"$tmp\"",
    "git push \"v$ver\" origin",
    "git push origin \"--no-ver$x\"",
    "find \"$(pwd)/..\" -name '*.log' -delete",
  ])("%s still asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).not.toBeNull();
  });
});

describe("branch moves through GraphQL", () => {
  const graphql = (query: string) => `gh api graphql -f query='${query}'`;
  it.each([
    graphql("mutation { updateRef(input:{refId:\"R\", oid:\"0123abc\", force:true}) { clientMutationId } }"),
    graphql("mutation { createCommitOnBranch(input:{branch:{repositoryNameWithOwner:\"o/r\", branchName:\"main\"}, message:{headline:\"x\"}, expectedHeadOid:\"0123abc\", fileChanges:{additions:[{path:\"a\", contents:\"eA==\"}]}}) { commit { oid } } }"),
    graphql("mutation { createRef(input:{repositoryId:\"R\", name:\"refs/heads/x\", oid:\"0\"}) { ref { name } } }"),
    graphql("mutation { mergeBranch(input:{repositoryId:\"R\", base:\"main\", head:\"x\"}) { mergeCommit { oid } } }"),
  ])("%s asks", (command) => {
    const hit = alwaysAsks({ tool: "Bash", command }, guard);
    expect(hit?.id).toBe("push-skips-checks");
    expect(hit?.ask).toMatch(/^This creates or moves a branch through the API, so the code on it runs none of its checks\./);
  });

  it("lets a query through", () => {
    expect(alwaysAsks({ tool: "Bash", command: graphql("query { viewer { login } }") }, guard)).toBeNull();
  });

  it("says a branch made through the REST API is a branch, not a push", () => {
    expect(alwaysAsks({ tool: "Bash", command: "gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=0123abc" }, guard)?.ask).toMatch(/^This creates or moves a branch through the API/);
  });
});

const THIRD_OUTSIDE: Row[] = ([
  ["cd .. && find . -name '*.log' -delete", "delete-outside-workspace"],
  ["find .. -name '*.log' -delete", "delete-outside-workspace"],
  ["find ~ -name '*.tmp' -delete", "delete-outside-workspace"],
  ["find / -name '*.tmp' -delete", "delete-outside-workspace"],
  ["find /srv/dogs -name '*.tmp' -delete", "delete-outside-workspace"],
  ["find /tmp -delete", null],
  ["find . ../other -delete", "delete-outside-workspace"],
  ["find ./ /srv/dogs/other -name x -delete", "delete-outside-workspace"],
  ["find -L link -delete", null],
  ["cd .. && git clean -fdx", "delete-outside-workspace"],
  ["git -C .. clean -fdx", "delete-outside-workspace"],
  ["git -C /srv/dogs/other clean -fdx", "delete-outside-workspace"],
  ["git --work-tree=/srv/dogs/other --git-dir=/srv/dogs/other/.git clean -fdx", "delete-outside-workspace"],
  ["git --work-tree /srv/dogs/other clean -fdx", "delete-outside-workspace"],
  ["GIT_WORK_TREE=/srv/dogs/other GIT_DIR=/srv/dogs/other/.git git clean -fdx", "delete-outside-workspace"],
  ["git clean -fdx ..", "delete-outside-workspace"],
  ["git clean -fdx -- ../other", "delete-outside-workspace"],
  ["rsync -a --delete /tmp/empty/ ./", null],
  ["rsync -a --delete /tmp/empty/ ../", "delete-outside-workspace"],
  ["rsync -a --delete /tmp/empty/ .", null],
  ["rm -rf .", "delete-outside-workspace"],
  ["rm -rf ./", "delete-outside-workspace"],
  ["rm -rf *", null],
  ["rm -rf ../*", "delete-outside-workspace"],
] as const).map(([command, expected]): Row => [`third outside root: ${command}`, bash(command), expected]);

const THIRD_ORDINARY: Row[] = [
  "git push -u origin \"$(git branch --show-current)\"",
  "cd \"$(git rev-parse --show-toplevel)\" && pnpm test",
  "export PATH=\"$(pnpm bin):$PATH\"",
  "echo \"Built at $(date -u +%FT%TZ)\" >> notes/log.md",
  "for f in $(git diff --name-only origin/main); do echo \"$f\"; done",
  "tmp=$(mktemp -d) && cp -r dist \"$tmp\" && rm -rf \"$tmp\"",
  "sha=$(git rev-parse HEAD); gh api repos/o/r/commits/$sha/status",
  "git log --oneline $(git merge-base HEAD origin/main)..HEAD",
  "pnpm exec vitest run $(git diff --name-only | grep test.ts)",
  "wc -l $(git ls-files 'server/*.ts') | tail -1",
  "echo $(( 1 + 2 ))",
  "ls -la \"$(dirname \"$(which node)\")\"",
  "curl -fsSL \"https://api.github.com/repos/o/r/commits/$(git rev-parse HEAD)/status\"",
  "git commit -m \"Release $(date +%F)\" && git push origin HEAD",
  "ver=$(node -p \"require('./package.json').version\"); git tag \"v$ver\" && git push origin \"v$ver\"",
  "find \"$(pwd)/logs\" -name '*.log' -delete",
  "rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"",
  "du -sh \"$(pnpm store path)\"",
  "kill $(cat /tmp/dev-server.pid) 2>/dev/null || true",
  "out=$(git push origin HEAD 2>&1); echo \"$out\"",
].map((command): Row => [`ordinary: ${command}`, bash(command), null]);

const graph = (query: string) => `gh api graphql -f query='${query}'`;
const THIRD_API: Row[] = ([
  ["gh api repos/o/r/git/refs/heads/main", null],
  ["gh api repos/o/r/git/matching-refs/heads/atelier", null],
  ["gh api repos/o/r/pulls -f title=x -f head=atelier/x -f base=main", null],
  ["gh api repos/o/r/issues/207/comments -f body='Looks good'", null],
  ["gh api -X PATCH repos/o/r/pulls/201 -F body=@notes/pr-body.md", null],
  ["gh api repos/o/r/pulls/207/reviews -f event=COMMENT -f body=x", null],
  [graph("query { viewer { login } }"), null],
  ["gh api repos/o/r/git/refs -f ref=refs/heads/atelier/x -f sha=0123abc", "push-skips-checks"],
  ["gh api -X PATCH repos/o/r/git/refs/heads/atelier/x -f sha=0123abc", "push-skips-checks"],
  ["gh api -X DELETE repos/o/r/git/refs/heads/atelier/old", null],
  [graph("mutation { updateRef(input:{refId:\"R\", oid:\"0123abc\", force:true}) { clientMutationId } }"), "push-skips-checks"],
  [graph("mutation { createCommitOnBranch(input:{branch:{repositoryNameWithOwner:\"o/r\", branchName:\"main\"}, message:{headline:\"x\"}, expectedHeadOid:\"0123abc\", fileChanges:{additions:[{path:\"a\", contents:\"eA==\"}]}}) { commit { oid } } }"), "push-skips-checks"],
  ["gh api -X PUT repos/o/r/contents/src/a.ts -f message=x -f content=eA== -f branch=main", "push-skips-checks"],
  ["gh api repos/o/r/merges -f base=main -f head=atelier/x", null],
  ["gh api -X PUT repos/o/r/pulls/1/merge", null],
  ["gh api repos/o/r/git/commits -f message=x -f tree=abc -f 'parents[]=def'", null],
] as const).map(([command, expected]): Row => [`third api: ${command}`, bash(command), expected]);

describe("the third review's inputs", () => {
  it.each([...THIRD_OUTSIDE, ...THIRD_ORDINARY, ...THIRD_API])("%s", (_label, request, expected) => {
    expect(alwaysAsks(request, guard)?.id ?? null).toBe(expected);
  });

  it("refuses the forced moves of the default branch the owner guard can place", async () => {
    const lookup = { currentBranch: async () => null, defaultBranch: async () => "main" };
    const refused = async (command: string) => (await ownerGuard({ tool: "Bash", command }, { ...guard(), git: lookup }))?.rule ?? null;
    expect(await refused("gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0123abc -F force=true")).toBe("force-push-default-branch");
    expect(await refused("gh api -X PATCH repos/o/r/git/refs/heads/master -F force=1 -f sha=0123abc")).toBe("force-push-default-branch");
    expect(await refused("gh api -X PATCH repos/o/r/git/refs/heads/trunk -F force=true -f sha=0123abc")).toBeNull();
    expect(await refused(graph("mutation { updateRef(input:{refId:\"R\", oid:\"0123abc\", force:true}) { clientMutationId } }"))).toBe("force-push-default-branch");
  });

  it("counts four cards over all 71 ordinary commands", () => {
    const ordinary = [...REVIEW_ROWS.filter(([label]) => label.startsWith("ordinary")), ...SECOND_ORDINARY, ...THIRD_ORDINARY];
    expect(ordinary).toHaveLength(71);
    expect(ordinary.filter(([, request]) => alwaysAsks(request, guard)).map(([label]) => label)).toEqual([
      "ordinary: the skip-hooks push from a home clone",
      "ordinary by design: xargs -a … rm -f",
      "ordinary by design: Edit .husky/pre-commit",
      "ordinary by design: lent Mac rm -rf node_modules",
    ]);
  });
});

describe("the repository folder a delete names", () => {
  const BOT = "/srv/dogs/ada/bot";
  const at = (cwd: string) => (): OwnerGuardContext => ({ ...guard(), cwd, workspaceRoots: [WORKSPACE, BOT] });
  const id = (command: string, cwd = WORKSPACE) => alwaysAsks({ tool: "Bash", command }, at(cwd))?.id ?? null;

  it("is the repository inside a clone", () => {
    expect(id("rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"")).toBeNull();
  });

  it("asks outside any repository, where the shell would give an empty folder", () => {
    expect(id("rm -rf \"$(git rev-parse --show-toplevel)/zz-probe\"", BOT)).toBe("delete-outside-workspace");
  });

  it("asks when the command points git at another repository", () => {
    expect(id("export GIT_WORK_TREE=/srv/dogs/other; rm -rf \"$(git rev-parse --show-toplevel)/precious-dir\"")).toBe("delete-outside-workspace");
    expect(id("GIT_WORK_TREE=/srv/dogs/other bash -c 'rm -rf \"$(git rev-parse --show-toplevel)/precious-dir\"'")).toBe("delete-outside-workspace");
    expect(id("GIT_DIR=/srv/dogs/other/.git rm -rf \"$(git rev-parse --show-toplevel)/x\"")).toBe("delete-outside-workspace");
  });

  it("reads a real .git on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "always-asks-repo-"));
    try {
      const clone = join(root, "clone");
      const bare = join(root, "bare");
      mkdirSync(join(clone, ".git"), { recursive: true });
      mkdirSync(bare);
      const real = (cwd: string) => (): OwnerGuardContext => ({ cwd, workspaceRoots: [clone, bare], tempRoots: [join(root, "scratch")], home: join(root, "home") });
      expect(alwaysAsks({ tool: "Bash", command: "rm -f \"$(git rev-parse --show-toplevel)/x\"" }, real(clone))).toBeNull();
      expect(alwaysAsks({ tool: "Bash", command: "rm -f \"$(git rev-parse --show-toplevel)/x\"" }, real(bare))?.id).toBe("delete-outside-workspace");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a temporary folder the command changes again", () => {
  it.each([
    "tmp=$(mktemp -d); tmp+=/../../srv/dogs/other/precious-dir; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); read -r tmp <<< \"/srv/dogs/other/precious-dir\"; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); for tmp in /srv/dogs/other/precious-dir; do :; done; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); printf -v tmp '%s' /srv/dogs/other/precious-dir; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); mapfile -t tmp < /tmp/list; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); tmp=/srv/dogs/other/precious-dir; rm -rf \"$tmp\"",
    "tmp=$(mktemp -d); declare tmp=/srv/dogs/other/precious-dir; rm -rf \"$tmp\"",
  ])("%s asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)?.id).toBe("delete-outside-workspace");
  });

  it("stays temporary when nothing writes it again", () => {
    expect(alwaysAsks({ tool: "Bash", command: "tmp=$(mktemp -d); cd /srv/dogs/other; rm -rf \"$tmp\"" }, guard)).toBeNull();
    expect(alwaysAsks({ tool: "Bash", command: "out=$(mktemp) && pnpm lint > \"$out\" 2>&1; tail -5 \"$out\"; rm -f \"$out\"" }, guard)).toBeNull();
  });
});

describe("a ref word the shell would split", () => {
  it.each([
    "B=' --no-verify'; git push origin x$B",
    "git push origin x$OPTS",
    "git push origin v$ver",
    "B=' --no-verify'; git push origin \"x\"$B",
  ])("%s asks", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)?.id).toBe("push-skips-checks");
  });

  it.each([
    "git push origin \"v$ver\"",
    "git push origin \"atelier/$name\"",
    "N=login; git push origin atelier/$N",
    "ver=$(node -p \"require('./package.json').version\"); git tag \"v$ver\" && git push origin \"v$ver\"",
  ])("%s does not", (command) => {
    expect(alwaysAsks({ tool: "Bash", command }, guard)).toBeNull();
  });
});

const BOTDIR = "/srv/dogs/ada/bot";
const LANE_TMP = "/tmp/zz-r4-chats/task1";
const OTHER = "/srv/dogs/other";
const lane = (cwd: string) => (): OwnerGuardContext => ({ ...guard(), cwd, workspaceRoots: [WORKSPACE, BOTDIR] });
const laneId = (command: string, cwd = WORKSPACE) => alwaysAsks({ tool: "Bash", command }, lane(cwd))?.id ?? null;

const RELAY_ORDINARY = [
  "git status --porcelain",
  "git fetch -q origin",
  "git clean -fdx",
  "git clean -fd -e .env -e notes/",
  "git reset --hard origin/main",
  "git checkout -- .",
  "git stash drop",
  "git branch -D atelier/old",
  "git push --force-with-lease origin atelier/x",
  "pnpm install --frozen-lockfile",
  "pnpm build && pnpm exec vitest run server/a.test.ts",
  "rm -rf node_modules dist .turbo",
  "rm -rf ./build/*",
  "find . -name '*.log' -mtime +3 -delete",
  "find . -type d -name __pycache__ -exec rm -rf {} +",
  "tmp=$(mktemp -d) && cp -r dist \"$tmp\" && rm -rf \"$tmp\"",
  "out=$(mktemp) && pnpm lint > \"$out\" 2>&1; tail -5 \"$out\"; rm -f \"$out\"",
  "rsync -a src/ \"$TMPDIR/copy/\"",
  "rm -rf \"$TMPDIR/copy\"",
  "rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"",
  "find \"$(pwd)/logs\" -name '*.tmp' -delete",
  "gh pr view 207 --json headRefOid",
  "gh pr comment 207 --body-file notes/review.md",
  "git push -u origin \"$(git branch --show-current)\"",
  "ver=$(node -p \"require('./package.json').version\"); git tag \"v$ver\" && git push origin \"v$ver\"",
];

const RELAY_OUTSIDE: Array<[string, AlwaysAskId | null]> = [
  [`cd ${OTHER} && rm -rf "$(pwd)/precious-dir"`, "delete-outside-workspace"],
  [`pushd ${OTHER} >/dev/null && rm -rf "$(pwd)/precious-dir"`, "delete-outside-workspace"],
  [`(cd ${OTHER}; rm -rf "$(pwd)/precious-dir")`, "delete-outside-workspace"],
  [`cd ${OTHER} && rm -f "$(git rev-parse --show-toplevel)/precious.txt"`, "delete-outside-workspace"],
  [`export GIT_WORK_TREE=${OTHER}; rm -rf "$(git rev-parse --show-toplevel)/precious-dir"`, "delete-outside-workspace"],
  [`GIT_WORK_TREE=${OTHER} bash -c 'rm -rf "$(git rev-parse --show-toplevel)/precious-dir"'`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); tmp=${OTHER}/precious-dir; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); tmp+=/../..${OTHER}/precious-dir; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); read -r tmp <<< "${OTHER}/precious-dir"; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); for tmp in ${OTHER}/precious-dir; do :; done; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); printf -v tmp '%s' ${OTHER}/precious-dir; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); declare tmp=${OTHER}/precious-dir; rm -rf "$tmp"`, "delete-outside-workspace"],
  [`tmp=$(mktemp -d); cd ${OTHER}; rm -rf "$tmp"`, null],
];

const RELAY_PUSHES: Array<[string, AlwaysAskId | null]> = [
  ["B=' --no-verify'; git push origin x$B", "push-skips-checks"],
  ["git push origin x$OPTS", "push-skips-checks"],
  ["B='--no-verify'; git push origin \"$B\"", "push-skips-checks"],
  ["git push origin x", null],
];

describe("the fourth review's inputs", () => {
  it.each(RELAY_OUTSIDE)("%s", (command, expected) => {
    expect(laneId(command)).toBe(expected);
  });

  it("asks for a repository folder named from a folder with no repository", () => {
    expect(laneId("rm -rf \"$(git rev-parse --show-toplevel)/zz-r4-probe\"", BOTDIR)).toBe("delete-outside-workspace");
  });

  it.each(RELAY_PUSHES)("%s", (command, expected) => {
    expect(laneId(command)).toBe(expected);
  });

  it("shows no card on the lane's ordinary commands from a clone, and only the repository-folder delete from folders with no repository", () => {
    const places = [["clone", WORKSPACE], ["temporary folder", LANE_TMP], ["bot folder", BOTDIR]] as const;
    const cards = places.flatMap(([place, cwd]) => RELAY_ORDINARY.filter((command) => laneId(command, cwd)).map((command) => `${place}: ${command}`));
    expect(RELAY_ORDINARY.length * places.length).toBe(75);
    expect(cards).toEqual([
      "temporary folder: rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"",
      "bot folder: rm -f \"$(git rev-parse --show-toplevel)/.eslintcache\"",
    ]);
  });
});
