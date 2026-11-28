import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHookSettings } from "../drivers/claude.ts";
import { answerHook, laterdogHookTarget } from "./hook-answer.ts";

const tokenFile = join(mkdtempSync(join(tmpdir(), "hook-answer-")), "token");
writeFileSync(tokenFile, "secret-token\n");

function hookCommand(): string {
  const settings = claudeHookSettings("/app/server/hooks/laterdog-hook.js", { guardShell: true, target: { url: "http://127.0.0.1:8799", tokenFile: "/data/it's/token" } });
  return ((settings.PostToolUse as Array<{ hooks: Array<{ command: string }> }>)[0]!.hooks[0]!.command);
}

describe("in-process later.dog hook", () => {
  it("recognises the later.dog hook command and nothing else", () => {
    expect(laterdogHookTarget(hookCommand())).toEqual({ url: "http://127.0.0.1:8799", tokenFile: "/data/it's/token" });
    expect(laterdogHookTarget("'/usr/bin/node' '/x/other-hook.js' 'http://127.0.0.1:1' '/t'")).toBeNull();
    expect(laterdogHookTarget("'/usr/bin/node' '/x/hooks/laterdog-hook.js' 'http://example.com' '/t'")).toBeNull();
    expect(laterdogHookTarget("node /x/hooks/laterdog-hook.js http://127.0.0.1:1 /t; rm -rf /")).toBeNull();
    expect(laterdogHookTarget("echo $(id)")).toBeNull();
  });

  it("answers like the helper: hook output, context for session events, nothing, or unavailable", async () => {
    const replies: unknown[] = [];
    const fetchReply = (body: unknown, status = 200) => (async (url: string, init: RequestInit) => {
      replies.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
      return Response.json(body, { status });
    }) as typeof fetch;
    const base = { url: "http://127.0.0.1:8799", tokenFile };
    const pre = { hook_event_name: "PreToolUse", tool_name: "Bash" };
    expect(await answerHook({ ...base, payload: pre, fetch: fetchReply({ hookSpecificOutput: { permissionDecision: "allow" } }) }))
      .toEqual({ stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }), code: 0 });
    expect(replies[0]).toEqual({ url: "http://127.0.0.1:8799/api/internal/hook", auth: "Bearer secret-token", body: { event: "PreToolUse", payload: pre } });
    expect(await answerHook({ ...base, payload: { hook_event_name: "SessionStart" }, fetch: fetchReply({ context: "notes" }) })).toEqual({ stdout: "notes", code: 0 });
    expect(await answerHook({ ...base, payload: { hook_event_name: "Stop" }, fetch: fetchReply({ context: "notes" }) })).toEqual({ stdout: "", code: 0 });
    expect(await answerHook({ ...base, payload: { hook_event_name: "Stop" }, fetch: fetchReply({ ok: true }) })).toEqual({ stdout: "", code: 0 });
    expect(await answerHook({ ...base, payload: { hook_event_name: "Stop" }, requireReply: true, fetch: fetchReply({}, 500) })).toEqual({ stdout: "", code: 2 });
    expect(await answerHook({ ...base, payload: "not an object", requireReply: true })).toEqual({ stdout: "", code: 2 });
    expect(await answerHook({ ...base, tokenFile: "/nonexistent", payload: pre })).toEqual({ stdout: "", code: 0 });
  });
});
