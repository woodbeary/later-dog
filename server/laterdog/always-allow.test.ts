import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import {
  asksEveryTime, chatOnlyGrants, commandKey, dogAllows, dogGrantKeys, grantKeyFor, grantToDog, revokeFromDog,
  type GrantRequest,
} from "./always-allow.ts";

const outside = mkdtempSync(join(tmpdir(), "always-outside-"));
const root = mkdtempSync(join(tmpdir(), "always-root-"));
mkdirSync(join(root, "src"), { recursive: true });
const roots = [root];
const run = (command: string, cwd = root) => commandKey(command, cwd, roots);
const ask = (request: Omit<GrantRequest, "roots">) => grantKeyFor({ ...request, roots });

afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the key a shell command is granted under", () => {
  it.each([
    ["git push origin feature", "run:git push"],
    ["git push --force origin main", "run:git push"],
    ["npm run build", "run:npm run"],
    ["pnpm run test -- --watch", "run:pnpm run"],
    ["docker compose up -d", "run:docker compose"],
    ["git commit -m \"fix the build\"", "run:git commit"],
    ["ls -la src", "run:ls"],
    ["rm -rf build", "run:rm"],
    ["pnpm dlx create-vite app", "run:pnpm dlx create-vite"],
    ["npx prettier --write .", "run:npx prettier"],
    ["gh pr create --draft", "run:gh pr"],
  ])("%s -> %s", (command, key) => {
    expect(run(command)).toBe(key);
  });

  it.each([
    "git status && git push",
    "cat notes.txt | grep todo",
    "bash -c \"git push\"",
    "sh deploy.sh",
    "python3 -c 'print(1)'",
    "python3 scripts/build.py",
    "node -e \"require('fs')\"",
    "sed -n 1e src/a.txt",
    "find . -name x -delete",
    "xargs rm",
    "sudo git push",
    "env FOO=1 git push",
    "FOO=1 git push",
    "./deploy.sh",
    "git -C src push",
    "git push --receive-pack=evil origin",
    "tar -x --to-command=evil -f a.tar",
    "echo $HOME",
    "git checkout HEAD~1",
    "npm",
  ])("%s is granted only as its exact text", (command) => {
    expect(run(command)).toBe(`exact:${command}`);
  });

  it("keeps paths outside the dog's folder to the exact text", () => {
    expect(run(`cp src/a.txt ${outside}/a.txt`)).toBe(`exact:cp src/a.txt ${outside}/a.txt`);
    expect(run("cat ../../../etc/passwd", join(root, "src"))).toBe("exact:cat ../../../etc/passwd");
    expect(run("git push", outside)).toBe("exact:git push");
    expect(run(`ls --dir=${outside}`)).toBe(`exact:ls --dir=${outside}`);
  });

  it("never grants deleting outside the dog's folder, sending mail, or paying from the shell", () => {
    expect(run(`rm -rf ${outside}`)).toBeUndefined();
    expect(run("rm -rf ../..")).toBeUndefined();
    expect(run("mail -s hi someone@example.com")).toBeUndefined();
    expect(run("echo hi | mail someone@example.com")).toBeUndefined();
    expect(run("osascript -e 'tell application \"Messages\" to send \"hi\"'")).toBeUndefined();
    expect(run("stripe charges create --amount 100")).toBeUndefined();
  });

  it("never stores a secret or an unbounded command as a key", () => {
    expect(run("export GH=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB && gh auth status")).toBeUndefined();
    expect(run(`echo ${"x".repeat(600)} | wc`)).toBeUndefined();
    expect(run("git status\ngit push")).toBeUndefined();
    expect(run("   ")).toBeUndefined();
  });

  it("does not follow a link out of the dog's folder", async () => {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(root, "escape"));
    expect(run(`cp a.txt ${join(root, "escape", "a.txt")}`)).toBe(`exact:cp a.txt ${join(root, "escape", "a.txt")}`);
    expect(ask({ tool: "Write", paths: [join(root, "escape", "key")] })).toBeUndefined();
  });
});

describe("the key each engine's request is granted under", () => {
  const push = { command: "git push origin feature", cwd: root };
  it.each<[string, Omit<GrantRequest, "roots">, string | undefined]>([
    ["Claude Bash", { tool: "Bash", command: push }, "run:git push"],
    ["Codex shell", { tool: "shell", command: push }, "run:git push"],
    ["ACP execute", { tool: "shell", command: push }, "run:git push"],
    ["Claude Bash without a readable command", { tool: "Bash" }, undefined],
    ["Claude Bash outside the sandbox", { tool: "Bash", command: push, requiresExplicitApproval: true }, undefined],
    ["Codex extra permissions", { tool: "permissions", requiresExplicitApproval: true }, undefined],
    ["Claude Edit inside", { tool: "Edit", paths: [join(root, "src", "a.ts")] }, "files:edit"],
    ["Claude Write of a new file inside", { tool: "Write", paths: [join(root, "src", "new", "b.ts")] }, "files:edit"],
    ["Claude NotebookEdit inside", { tool: "NotebookEdit", paths: [join(root, "n.ipynb")] }, "files:edit"],
    ["Codex edit inside", { tool: "edit", paths: [join(root, "src", "a.ts"), join(root, "b.ts")] }, "files:edit"],
    ["ACP edit inside", { tool: "edit", paths: [join(root, "a.ts")] }, "files:edit"],
    ["Claude Write outside", { tool: "Write", paths: [join(outside, "x")] }, undefined],
    ["Codex edit touching outside", { tool: "edit", paths: [join(root, "a.ts"), join(outside, "x")] }, undefined],
    ["Edit with no known path", { tool: "edit" }, undefined],
    ["Claude MCP tool", { tool: "mcp__github__create_issue" }, "tool:github/create_issue"],
    ["Claude web fetch", { tool: "WebFetch" }, "tool:webfetch"],
    ["Codex MCP tool", { tool: "create_issue" }, "tool:create_issue"],
    ["Codex MCP tool with no name", { tool: "mcp" }, undefined],
    ["ACP fetch", { tool: "fetch" }, "tool:fetch"],
    ["ACP generic tool", { tool: "other" }, undefined],
    ["ACP delete", { tool: "delete" }, undefined],
    ["Pi confirmation", { tool: "Allow bash command?" }, undefined],
    ["OpenAI-chat display title", { tool: "Read file" }, undefined],
    ["Claude computer tool on the person's computer", { tool: "mcp__computer__click", approvalScope: "local-computer" }, "computer:tool:computer/click"],
    ["Codex shell on the person's computer", { tool: "shell", command: push, approvalScope: "local-computer" }, "computer:run:git push"],
    ["Email send", { tool: "mcp__gmail__send_email" }, undefined],
    ["Reply to an email thread", { tool: "GMAIL_REPLY_TO_THREAD" }, undefined],
    ["Text from the Mac", { tool: "mac_send_text" }, undefined],
    ["Slack message", { tool: "SLACK_SEND_MESSAGE" }, undefined],
    ["Payment", { tool: "mcp__stripe__create_payment_intent" }, undefined],
    ["Purchase", { tool: "buy_item" }, undefined],
    ["A post, not a message", { tool: "TWITTER_CREATION_OF_A_POST" }, "tool:twitter_creation_of_a_post"],
  ])("%s", (_name, request, key) => {
    expect(ask(request)).toBe(key);
  });

  it("keeps a program grant from opening the person's computer and the reverse", () => {
    const sandbox = ask({ tool: "Bash", command: push });
    const host = ask({ tool: "shell", command: push, approvalScope: "local-computer" });
    expect(sandbox).not.toBe(host);
  });

  it("says which kinds always ask", () => {
    expect(asksEveryTime("mac_send_email")).toBe(true);
    expect(asksEveryTime("type_text")).toBe(false);
    expect(asksEveryTime("Bash")).toBe(false);
  });
});

describe("where a lasting approval is kept and read", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
  let store: Store;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    store = new Store(selection);
  });

  const dogWithTwoChats = () => {
    const dog = store.createBot({ name: "Rex" });
    const first = dog.threadId;
    const second = store.createTask(dog.id, "second", false)!.threadId;
    return { dog, first, second };
  };

  it("holds in every chat of the dog, including chats made before and after", () => {
    const { dog, first, second } = dogWithTwoChats();
    grantToDog(store, dog.id, "run:git push");
    const third = store.createTask(dog.id, "third", false)!.threadId;
    for (const threadId of [first, second, third]) expect(dogAllows(store, dog.id, threadId, "run:git push")).toBe(true);
  });

  it("holds when the dog works in a thread it does not own, for a teammate or a helper", () => {
    const { dog } = dogWithTwoChats();
    const teammate = store.createBot({ name: "Juniper" });
    grantToDog(store, dog.id, "files:edit");
    expect(dogAllows(store, dog.id, teammate.threadId, "files:edit")).toBe(true);
    expect(dogAllows(store, teammate.id, teammate.threadId, "files:edit")).toBe(false);
  });

  it("survives a restart", () => {
    const { dog, second } = dogWithTwoChats();
    grantToDog(store, dog.id, "run:npm run");
    const reopened = new Store(selection);
    expect(dogAllows(reopened, dog.id, second, "run:npm run")).toBe(true);
  });

  it("keeps an approval stored on one chat working there and only there", () => {
    const { dog, first, second } = dogWithTwoChats();
    store.patchTask(dog.id, first, { alwaysAllow: ["connector:github"] });
    expect(dogAllows(store, dog.id, first, "connector:github")).toBe(true);
    expect(dogAllows(store, dog.id, second, "connector:github")).toBe(false);
    expect(chatOnlyGrants(store, dog.id)).toEqual(["connector:github"]);
  });

  it("asks again once removed, from the dog and from every chat copy", () => {
    const { dog, first, second } = dogWithTwoChats();
    grantToDog(store, dog.id, "run:git push");
    store.patchTask(dog.id, first, { alwaysAllow: ["run:git push", "tool:webfetch"] });
    revokeFromDog(store, dog.id, "run:git push");
    expect(dogAllows(store, dog.id, first, "run:git push")).toBe(false);
    expect(dogAllows(store, dog.id, second, "run:git push")).toBe(false);
    expect(dogGrantKeys(store, dog.id, first)).toEqual(["tool:webfetch"]);
    expect(dogAllows(new Store(selection), dog.id, first, "run:git push")).toBe(false);
  });

  it("does not store the same key twice", () => {
    const { dog } = dogWithTwoChats();
    grantToDog(store, dog.id, "tool:webfetch");
    grantToDog(store, dog.id, "tool:webfetch");
    expect(store.bot(dog.id)!.alwaysAllow).toEqual(["tool:webfetch"]);
  });
});
