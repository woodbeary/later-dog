import { describe, expect, it } from "vitest";
import { supervisorEnv } from "../../deploy/laterdog/cloudflare/src/supervisor-env.ts";

describe("what the cloud supervisor's container gets from its Worker", () => {
  it("passes the Claude API key and the screen-check switch for computer-use runs, beside what it already passed", () => {
    const env = {
      LATERDOG_TOKEN: "fixture-token", LATERDOG_BACKUP_KEY: "fixture-backup", GH_TOKEN: "ghp_fixture", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fixture",
      CLAUDE_CODE_OAUTH_TOKEN_WORK: "sk-ant-oat01-work", ANTHROPIC_API_KEY: "sk-ant-api03-fixture", LATERDOG_SCREEN_CHECKS: "on", TRACE_RETENTION_DAYS: "30",
      LATERDOG_WORKSPACE_URL: "https://workspace.fixture.example", COMPUTERS: { fetch: () => null }, LATERDOG_COMPUTERS_PUBLIC_URL: "https://cloud.later.dog",
    };
    expect(supervisorEnv(env, "http://state.r2")).toEqual({
      LATERDOG_TOKEN: "fixture-token", LATERDOG_BACKUP_KEY: "fixture-backup", LATERDOG_STATE_URL: "http://state.r2", GH_TOKEN: "ghp_fixture",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fixture", CLAUDE_CODE_OAUTH_TOKEN_WORK: "sk-ant-oat01-work", ANTHROPIC_API_KEY: "sk-ant-api03-fixture",
      LATERDOG_SCREEN_CHECKS: "on", LATERDOG_TRACE_RETENTION_DAYS: "30", LATERDOG_WORKSPACE_URL: "https://workspace.fixture.example",
    });
  });

  it("leaves out what is not set", () => {
    expect(supervisorEnv({ LATERDOG_TOKEN: "t", LATERDOG_BACKUP_KEY: "b", ANTHROPIC_API_KEY: "" }, "http://state.r2"))
      .toEqual({ LATERDOG_TOKEN: "t", LATERDOG_BACKUP_KEY: "b", LATERDOG_STATE_URL: "http://state.r2" });
  });
});
