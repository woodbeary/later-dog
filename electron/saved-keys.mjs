import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SAVED_KEY_NAMES = {
  xaiApiKey: {
    names: ["XAI_API_KEY", "GROK_API_KEY", "XAI_KEY", "GROK_KEY"],
    services: ["xai", "x.ai", "api.x.ai", "grok"],
    looksRight: (value) => /^xai-[A-Za-z0-9_-]{20,}$/.test(value),
  },
  ttsKey: {
    names: ["ELEVENLABS_API_KEY", "ELEVEN_API_KEY", "ELEVENLABS_KEY", "XI_API_KEY"],
    services: ["elevenlabs", "api.elevenlabs.io"],
    looksRight: (value) => /^(sk_)?[A-Za-z0-9]{32,}$/.test(value),
  },
  openaiImageApiKey: {
    names: ["OPENAI_API_KEY", "OPENAI_KEY"],
    services: ["openai", "api.openai.com"],
    looksRight: (value) => /^sk-[A-Za-z0-9_-]{20,}$/.test(value),
  },
};

export const SHELL_FILES = [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile", ".env", ".config/fish/config.fish"];

const ASSIGNMENT = /^\s*(?:export\s+|set\s+-gx\s+|setenv\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*|\s+)(["']?)([^"'\s#]+)\2\s*(?:#.*)?$/;

export function keysInShellText(text, names) {
  const found = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line);
    if (match && names.includes(match[1]) && !match[3].includes("$")) found.set(match[1], match[3]);
  }
  return found;
}

const hintFor = (value) => `…${value.slice(-4)}`;

function runSecurity(args) {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", args, { timeout: 60_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export function createSavedKeys({
  home = os.homedir(),
  env = process.env,
  read = (file) => readFile(file, "utf8"),
  security = process.platform === "darwin" ? runSecurity : async () => null,
} = {}) {
  async function scan(target) {
    const spec = SAVED_KEY_NAMES[target];
    if (!spec) return [];
    const found = [];
    const seen = new Set();
    const add = (entry) => {
      const key = entry.value ?? `keychain:${entry.service}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push(entry);
    };
    for (const name of spec.names) {
      const value = env[name]?.trim();
      if (value && spec.looksRight(value)) add({ id: `env:${name}`, label: `${name} in later.dog's environment`, value });
    }
    for (const file of SHELL_FILES) {
      const text = await read(path.join(home, file)).catch(() => null);
      if (text == null) continue;
      for (const [name, value] of keysInShellText(text, spec.names)) {
        if (spec.looksRight(value)) add({ id: `file:${file}:${name}`, label: `${name} in ~/${file}`, value });
      }
    }
    for (const service of [...spec.names, ...spec.services]) {
      if ((await security(["find-generic-password", "-s", service])) != null) {
        add({ id: `keychain:${service}`, label: `"${service}" in your Keychain`, service });
      }
    }
    return found;
  }

  return {
    async find(target) {
      const found = await scan(target);
      return found.map(({ id, label, value }) => ({ id, label, hint: value ? hintFor(value) : null }));
    },
    async read(target, id) {
      const spec = SAVED_KEY_NAMES[target];
      const entry = (await scan(target)).find((candidate) => candidate.id === id);
      if (!spec || !entry) throw new Error("That saved key is no longer there.");
      const value = entry.value ?? (await security(["find-generic-password", "-s", entry.service, "-w"]))?.trim();
      if (!value) throw new Error("macOS didn't allow reading that Keychain item.");
      if (!spec.looksRight(value)) throw new Error("That saved item doesn't look like this kind of key.");
      return value;
    },
  };
}
