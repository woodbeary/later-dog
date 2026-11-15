import { describe, expect, it } from "vitest";
import { ALWAYS_ASK_IDS, alwaysAskHook, alwaysAsks, connectorAlwaysAsks, type AlwaysAskId } from "./always-asks.ts";
import type { OwnerGuardContext } from "./owner-guard.ts";

const WORKSPACE = "/srv/dogs/ada/work";
const guard = (): OwnerGuardContext => ({ cwd: WORKSPACE, workspaceRoots: [WORKSPACE], tempRoots: ["/tmp"], home: "/home/dog" });
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
