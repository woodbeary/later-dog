import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { codexExternalAccount, codexExternalAuthChannel, redactCodexExternalAuthFrame } from "./codex-external-auth.ts";

const workspace = "fixture-workspace";
const initial = "fixture-access-first";
const renewed = "fixture-access-second";
const sourceStore = (access: string, account = workspace) => ({ auth_mode: "chatgpt", tokens: {
  account_id: account, access_token: access, refresh_token: "fixture-home-refresh", id_token: "fixture-home-id",
} });

it("uses only the owner's access token for the app-server login and concurrent refreshes and keeps each auth frame out of traces", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createInterface } from "node:readline";
    const send = frame => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...frame}) + "\\n");
    let renewed = 0;
    createInterface({input: process.stdin}).on("line", raw => {
      const frame = JSON.parse(raw);
      if (frame.method === "account/login/start") {
        assert.deepEqual(frame.params, {type: "chatgptAuthTokens", accessToken: ${JSON.stringify(initial)}, chatgptAccountId: ${JSON.stringify(workspace)}});
        send({id: frame.id, result: {type: "chatgptAuthTokens", privateEcho: ${JSON.stringify(initial)}}});
        send({id: 1, method: "account/chatgptAuthTokens/refresh", params: {reason: "unauthorized", previousAccountId: ${JSON.stringify(workspace)}}});
        send({id: "refresh-2", method: "account/chatgptAuthTokens/refresh", params: {reason: "unauthorized", previousAccountId: null}});
        return;
      }
      assert.deepEqual(frame.result, {accessToken: ${JSON.stringify(renewed)}, chatgptAccountId: ${JSON.stringify(workspace)}});
      if (++renewed === 2) send({method: "fixture/confirmed", params: {refreshes: renewed}});
    });
  `], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const read = vi.fn(async () => sourceStore(initial));
  let completeRenewal!: (value: unknown) => void;
  const refresh = vi.fn(() => new Promise(resolve => { completeRenewal = resolve; }));
  const channel = codexExternalAuthChannel(codexExternalAccount(workspace, { read, refresh }), child.stdin);
  const traces: unknown[] = [];
  const lines = createInterface({ input: child.stdout });
  let refreshRequests = 0;
  const confirmed = new Promise<void>((resolve) => {
    lines.on("line", line => {
      const frame = JSON.parse(line);
      if (!channel.receive(frame)) traces.push(frame);
      if (frame.method === "account/chatgptAuthTokens/refresh" && ++refreshRequests === 2) completeRenewal(sourceStore(renewed));
      if (frame.method === "fixture/confirmed") resolve();
    });
  });
  try {
    await Promise.race([Promise.all([channel.signIn(), confirmed]), closed.then(([code]) => { throw new Error(`The fake app-server exited ${code}.`); })]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(traces).toEqual([{ jsonrpc: "2.0", method: "fixture/confirmed", params: { refreshes: 2 } }]);
  } finally {
    channel.close();
    child.stdin.end();
    lines.close();
    expect((await closed)[0]).toBe(0);
  }
});

it("consumes an echoed login refusal and reports only the safe home account error", async () => {
  const stdin = new PassThrough();
  const channel = codexExternalAuthChannel(codexExternalAccount(workspace, {
    read: async () => sourceStore(initial), refresh: async () => sourceStore(renewed),
  }), stdin);
  stdin.on("data", bytes => {
    const request = JSON.parse(String(bytes));
    expect(channel.receive({ id: request.id, error: { code: -32600, message: initial } })).toBe(true);
  });
  await expect(channel.signIn()).rejects.toThrow(/^The home could not lend the selected Codex account\.$/);
  channel.close();
});

it("refuses a different account on login, a refresh aimed at a different account and a renewed credential for a different account", async () => {
  const stdin = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  stdin.on("data", bytes => sent.push(JSON.parse(String(bytes))));
  const bad = codexExternalAuthChannel(codexExternalAccount(workspace, {
    read: async () => sourceStore(initial, "other-workspace"), refresh: async () => sourceStore(renewed),
  }), stdin);
  await expect(bad.signIn()).rejects.toThrow("selected Codex account");
  expect(sent).toEqual([]);
  bad.close();

  const refresh = vi.fn(async () => sourceStore(renewed, "other-workspace"));
  const channel = codexExternalAuthChannel(codexExternalAccount(workspace, { read: async () => sourceStore(initial), refresh }), stdin);
  const login = channel.signIn();
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  channel.receive({ id: sent[0]!.id, result: { type: "chatgptAuthTokens" } });
  await login;
  channel.receive({ id: 1, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "other-workspace" } });
  channel.receive({ id: 2, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: workspace } });
  await vi.waitFor(() => expect(sent).toHaveLength(3));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(sent.slice(1)).toEqual([1, 2].map(id => ({ jsonrpc: "2.0", id, error: { code: -32000, message: "The home could not refresh the selected Codex account." } })));
  channel.close();
});

it("redacts auth request, refresh result and echoed login errors and leaves the local device-code exchange alone", () => {
  const privateFrames = [
    { id: 1, method: "account/login/start", params: { type: "chatgptAuthTokens", accessToken: initial } },
    { id: 2, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: workspace } },
    { id: 2, result: { accessToken: renewed, chatgptAccountId: workspace } },
    { id: "laterdog-external-account-fixture", error: { code: -32600, data: initial } },
  ];
  for (const frame of privateFrames) {
    const redacted = redactCodexExternalAuthFrame(frame);
    expect(redacted).toMatchObject({ auth: "[account authentication omitted]" });
    expect(JSON.stringify(redacted)).not.toMatch(/fixture-access|fixture-workspace/);
  }
  const local = { id: 1, method: "account/login/start", params: { type: "chatgptDeviceCode" } };
  expect(redactCodexExternalAuthFrame(local)).toBe(local);
});
