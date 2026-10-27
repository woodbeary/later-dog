import { describe, expect, it } from "vitest";

import { createSavedKeys, keysInShellText } from "./saved-keys.mjs";

const XAI = "xai-abcdefghijklmnopqrstuvwxyz0123";
const OTHER_XAI = "xai-zyxwvutsrqponmlkjihgfedcba9876";

function fixture({ env = {}, files = {}, keychain = {} } = {}) {
  const calls = [];
  const savedKeys = createSavedKeys({
    home: "/home/fixture",
    env,
    read: async (file) => {
      if (file in files) return files[file];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    security: async (args) => {
      calls.push(args);
      const service = args[args.indexOf("-s") + 1];
      if (!(service in keychain)) return null;
      return args.includes("-w") ? `${keychain[service]}\n` : "attributes only";
    },
  });
  return { savedKeys, calls };
}

describe("finding keys already saved on this Mac", () => {
  it("reads export lines in the shell files people keep keys in", () => {
    const text = [
      `export XAI_API_KEY="${XAI}"`,
      "# export GROK_API_KEY=xai-commented-out",
      "GROK_API_KEY=$XAI_API_KEY",
      `set -gx XAI_KEY '${OTHER_XAI}'`,
    ].join("\n");
    expect([...keysInShellText(text, ["XAI_API_KEY", "GROK_API_KEY", "XAI_KEY"])]).toEqual([
      ["XAI_API_KEY", XAI],
      ["XAI_KEY", OTHER_XAI],
    ]);
  });

  it("lists where a key was found with only its last four characters", async () => {
    const { savedKeys } = fixture({
      env: { XAI_API_KEY: XAI },
      files: { "/home/fixture/.zshrc": `export GROK_API_KEY=${OTHER_XAI}\nexport XAI_API_KEY=${XAI}\n` },
    });
    const found = await savedKeys.find("xaiApiKey");
    expect(found).toEqual([
      { id: "env:XAI_API_KEY", label: "XAI_API_KEY in later.dog's environment", hint: "…0123" },
      { id: "file:.zshrc:GROK_API_KEY", label: "GROK_API_KEY in ~/.zshrc", hint: "…9876" },
    ]);
    expect(JSON.stringify(found)).not.toContain(XAI);
    expect(JSON.stringify(found)).not.toContain(OTHER_XAI);
  });

  it("finds Keychain items by name without reading them until one is chosen", async () => {
    const { savedKeys, calls } = fixture({ keychain: { "api.x.ai": XAI } });
    expect(await savedKeys.find("xaiApiKey")).toEqual([
      { id: "keychain:api.x.ai", label: "\"api.x.ai\" in your Keychain", hint: null },
    ]);
    expect(calls.some((args) => args.includes("-w"))).toBe(false);
    expect(await savedKeys.read("xaiApiKey", "keychain:api.x.ai")).toBe(XAI);
    expect(calls.at(-1)).toEqual(["find-generic-password", "-s", "api.x.ai", "-w"]);
  });

  it("skips values that are not the right kind of key", async () => {
    const { savedKeys } = fixture({
      env: { XAI_API_KEY: "placeholder" },
      files: { "/home/fixture/.env": "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n" },
      keychain: { grok: "not-a-key" },
    });
    expect(await savedKeys.find("openaiImageApiKey")).toHaveLength(1);
    await expect(savedKeys.read("xaiApiKey", "keychain:grok")).rejects.toThrow("doesn't look like");
    await expect(savedKeys.read("xaiApiKey", "env:XAI_API_KEY")).rejects.toThrow("no longer there");
  });

  it("knows nothing about targets it does not support", async () => {
    const { savedKeys } = fixture({ env: { XAI_API_KEY: XAI } });
    expect(await savedKeys.find("boxToken")).toEqual([]);
    await expect(savedKeys.read("boxToken", "env:XAI_API_KEY")).rejects.toThrow();
  });
});
