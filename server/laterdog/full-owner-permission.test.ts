import { describe, expect, it } from "vitest";
import { alwaysAskHook, alwaysAsks, connectorAlwaysAsks } from "./always-asks.ts";
import { ownerAutoAnswers } from "./owner-auto.ts";
import { settleOwnerAutoPermission, type OwnerAutoPermission } from "./owner-auto-request.ts";
import { defaultTempRoots, ownerGuard, type OwnerGuardContext } from "./owner-guard.ts";

const workspace = "/srv/dogs/ada/work";
const full = () => ({
  cwd: workspace,
  workspaceRoots: [workspace, "/srv/dogs/ada/tasks"],
  tempRoots: defaultTempRoots(),
  home: "/home/dog",
  ownerFull: true,
  repositoryRoot: (cwd: string) =>
    cwd.startsWith(workspace + "/repo") ? workspace + "/repo" : null,
  git: { currentBranch: async () => "main", defaultBranch: async () => "main" },
});
const settle = async (request: OwnerAutoPermission) => {
  const calls: string[] = [];
  const result = await settleOwnerAutoPermission(request, {
    guard: full(),
    allow: async () => {
      calls.push("allow");
      return "allowed-once";
    },
    deny: async (message) => {
      calls.push(message);
      return "rejected";
    },
    hold: () => calls.push("card"),
    holdAlways: (hit) => calls.push("card: " + hit.id),
    refusedAlways: () => {},
    isCurrent: () => true,
    approved: () => {},
    refused: () => {},
    failed: () => {},
  });
  return { result, calls };
};

describe("a Full access owner's dog never delegates routine permissions back to the owner", () => {
  it("settles owner Full escalations even with Auto-review on, while excluding guests and shared workspaces", () => {
    const scope = { cloudHome: true, sharedWorkspace: false, guestDriven: false, autoReview: true };
    expect(ownerAutoAnswers("full", scope)).toBe(true);
    expect(ownerAutoAnswers("full", { ...scope, guestDriven: true })).toBe(false);
    expect(ownerAutoAnswers("full", { ...scope, sharedWorkspace: true })).toBe(false);
    expect(ownerAutoAnswers("ask", scope)).toBe(false);
  });

  it.each([
    'd=build; rm -rf "$d"',
    'export d=build; rm -rf "${d}/old"',
    'base="$PWD"; d="$base/build"; rm -rf "$d"',
    'base="$TMPDIR"; d="$base/scratch"; rm -rf "$d"',
    'd="$HOME/.cache/pnpm"; rm -rf "$d"',
    'd=/srv/dogs/ada/tasks/task1/build; rm -rf "$d"',
    'd=$(mktemp -d); rm -rf "$d"',
    'IFS=:; d="$PWD/build:/"; rm -rf "$d"',
    'd="$HOME/.cache/item"; rm -rf "$d"',
    `eval 'd="$HOME/.cache/item"'; rm -rf "$d"`,
    `export d="$PWD/build"; sh -c 'rm -rf "$d"'`,
    `d=build; out=$(d=/etc; printf ok); rm -rf "$d"`,
    'd="build /"; rm -rf "out=$d"',
  ])("resolves safe cleanup without a card: %s", async (command) => {
    expect(await settle({ tool: "Bash", command })).toEqual({
      result: "approved",
      calls: ["allow"],
    });
    expect(alwaysAskHook({ tool_name: "Bash", tool_input: { command } }, full)).toBeNull();
  });

  it.each([
    'rm -rf "$d"',
    'd=$(cat target); rm -rf "$d"',
    'd=build; read d; rm -rf "$d"',
    "rm -rf /srv/dogs/other",
    "rm -rf /",
    "rm -rf /data",
    "rm -rf /home/dog",
    "rm -rf /srv/dogs/ada/work",
    "rm -rf /srv/dogs/ada/work/repo",
    "rm -rf /tmp",
    'rm -rf "$HOME_NOT_A_PATH"',
    "d='build /'; rm -rf $d",
    'git --work-tree="$unknown" clean -fdx',
    "cat targets | xargs rm -rf",
    'TMPDIR=/home/dog; d=$(mktemp -d); rm -rf "$d"',
    'TMPDIR=/etc; d=$(mktemp -d); rm -rf "$d"',
    'read TMPDIR; d=$(mktemp -d); rm -rf "$d"',
    `sh -c 'd="$HOME/.cache/item"'; rm -rf "$d"`,
    'out=$(d="$HOME/.cache/item"; printf ok); rm -rf "$d"',
    'IFS=:; d="$PWD/build:/"; rm -rf $d',
    'read IFS; d="$PWD/build"; rm -rf $d',
    `d="$PWD/build"; sh -c 'rm -rf "$d"'`,
    'd=build; unset d; rm -rf "$d"',
    `export d=build; export -n d; sh -c 'rm -rf "$d"'`,
    'd="build /"; rm -rf out=$d',
    'unset PWD; d="$PWD/build"; rm -rf "$d"',
    'read PWD; d="$PWD/build"; rm -rf "$d"',
  ])("refuses uncertain or protected cleanup to the dog: %s", async (command) => {
    const settled = await settle({ tool: "Bash", command });
    expect(settled.result).toBe("refused");
    expect(settled.calls).toHaveLength(1);
    expect(settled.calls[0]).toMatch(/^later.dog refused this:/);
    expect(settled.calls[0]).not.toMatch(/ask|allow only|person.s yes/i);
    const hook = alwaysAskHook({ tool_name: "Bash", tool_input: { command } }, full);
    expect(hook).toMatchObject({ permissionDecision: "deny" });
    expect(hook?.permissionDecisionReason).toBe(settled.calls[0]);
  });

  it("refuses an unresolved Mac cleanup without a card", async () => {
    const result = await settle({
      tool: "mcp__agents__shared_computer",
      input: { action: "run_command", command: 'rm -rf "$unknown"' },
    });
    expect(result.result).toBe("refused");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("Write the literal path");
  });

  it("keeps unresolved paths actionable and never offers an approval", async () => {
    const refusal = await ownerGuard({ tool: "Bash", command: 'rm -rf "$d"' }, full());
    expect(refusal?.message).toContain("Write the literal path");
    expect(refusal?.ask).toBeUndefined();
  });

  it.each([
    { tool: "Bash", command: "gcloud iam service-accounts keys create k.json --iam-account=a" },
    {
      tool: "mcp__computer__open_url",
      input: { url: "https://console.cloud.google.com/apis/credentials" },
    },
    { tool: "mcp__composio__GMAIL_DELETE_MESSAGE", input: { id: "example" } },
    { tool: "mcp__composio__GOOGLEDRIVE_UPDATE_FILE_PERMISSION", input: { id: "example" } },
  ])("lets routine account work proceed: $tool", async (request) => {
    expect(alwaysAsks(request, full)).toBeNull();
    expect(await settle(request)).toEqual({ result: "approved", calls: ["allow"] });
  });

  it("returns skipped checks to the dog without a card", async () => {
    const settled = await settle({ tool: "Bash", command: "git push --no-verify origin main" });
    expect(settled.result).toBe("refused");
    expect(settled.calls).toHaveLength(1);
    expect(settled.calls[0]).toMatch(/checks/);
    expect(
      alwaysAskHook(
        { tool_name: "Bash", tool_input: { command: "git push --no-verify origin main" } },
        full,
      ),
    ).toMatchObject({ permissionDecision: "deny" });
  });

  it.each([
    ["mcp__mail__send_email", "sends-for-you"],
    ["mcp__shop__chargeCard", "pays"],
  ])("keeps confirmation for %s", async (tool, id) => {
    expect(await settle({ tool })).toEqual({ result: "held", calls: ["card: " + id] });
  });

  it("applies the same exceptions to connected app batches", () => {
    expect(connectorAlwaysAsks(["GMAIL_DELETE_MESSAGE"], true)).toBeNull();
    expect(connectorAlwaysAsks(["GMAIL_SEND_EMAIL"], true)?.id).toBe("sends-for-you");
    expect(connectorAlwaysAsks(["STRIPE_CREATE_PAYMENT_INTENT"], true)?.id).toBe("pays");
    expect(connectorAlwaysAsks(["GMAIL_DELETE_MESSAGE", "GMAIL_SEND_EMAIL"], true)?.id).toBe(
      "sends-for-you",
    );
  });

  it("preserves existing approval rules without owner Full authority", () => {
    const guard = (): OwnerGuardContext => ({ ...full(), ownerFull: false });
    expect(
      alwaysAskHook({ tool_name: "Bash", tool_input: { command: 'rm -rf "$d"' } }, guard),
    ).toMatchObject({ permissionDecision: "ask" });
    expect(alwaysAsks({ tool: "mcp__mail__send_email" }, guard)?.id).toBe("sends-for-you");
  });
});
