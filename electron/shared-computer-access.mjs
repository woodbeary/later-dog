import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { lentScreenArguments, lentScreenToolListing } from "./lent-screen-tools.mjs";
import { createCommandRunner, createLoginEnvironment } from "./mac-commands.mjs";
import { searchFolder } from "./mac-search.mjs";

const commands = createCommandRunner({ environment: createLoginEnvironment() });
export const stopSharedCommands = () => commands.stopAll();
export const SHARED_ACTIONS = Object.freeze([
  "list_files", "read_file", "write_file", "edit_file", "delete_file", "search_files",
  "run_command", "command_output", "command_input", "command_stop", "computer_tools", "computer_call",
]);
const COMMAND_ACTIONS = new Set(["run_command", "command_output", "command_input", "command_stop"]);
const FILE_ACTIONS = new Set(["list_files", "read_file", "write_file", "edit_file", "delete_file", "search_files"]);

const LIMIT = 256 * 1024;
export const LENT_FILE_MAX = 25 * 1024 * 1024;
const PROTECTED = "Desktop credentials and sharing settings cannot be accessed through a shared folder";
const GIT_INTERNALS = "Files inside .git cannot be changed through a shared folder: git runs commands from its configuration and hooks";
const OUTSIDE_HOME = "later.dog can only use files in this computer's home folder.";
const MAC_BLOCKED = "macOS blocked later.dog from that file. On the Mac, open System Settings → Privacy & Security → Full Disk Access and turn on later.dog, or move the file to Downloads.";
const PRIVATE_FOLDERS = ["Downloads", "Desktop", "Documents"];
const ASK_WAIT_MS = 3000;
const PROBE_MAX_MS = 5 * 60_000;

const PERSONAL_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".npmrc", ".pypirc",
  ".claude", ".claude.json", ".codex", ".mozilla", ".local/share/keyrings", ".local/bin",
  ".config/gh", ".config/gcloud", ".config/op", ".config/git", ".config/fish", ".config/autostart", ".config/systemd",
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
  "Library/Keychains", "Library/Cookies", "Library/LaunchAgents", "Library/Safari",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware", "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Firefox", "Library/Application Support/Arc",
];
export function personalSecretPaths(home) {
  return typeof home === "string" && home ? PERSONAL_SECRETS.map(entry => path.join(home, ...entry.split("/"))) : [];
}

export { LENT_SCREEN_TOOLS } from "./lent-screen-tools.mjs";

const gitComponent = part => part.normalize("NFC").toLowerCase() === ".git";
const insideGitInternals = (root, relative) => root.split(path.sep).some(gitComponent) || relative.split("/").some(gitComponent);
const hash = data => createHash("sha256").update(data).digest("hex");
const absent = error => error.code === "ENOENT" || error.code === "ENOTDIR";
const identify = async candidate => { const info = await fs.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };

async function protectedIdentities(roots) {
  const identities = new Set();
  for (const root of roots ?? []) {
    if (typeof root !== "string" || !root) continue;
    try { identities.add(await identify(await fs.realpath(root))); }
    catch (error) { if (!absent(error)) throw error; }
  }
  return identities;
}

async function assertOutsideProtected(identities, target) {
  if (!identities.size) return;
  let current = path.resolve(target);
  for (;;) {
    try { current = await fs.realpath(current); break; }
    catch (error) {
      if (!absent(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
  for (;;) {
    let identity;
    try { identity = await identify(current); }
    catch (error) { if (!absent(error)) throw error; }
    if (identity !== undefined && identities.has(identity)) throw new Error(PROTECTED);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const text = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

const basenameMessage = message => {
  const original = String(message);
  if (!original.match(/(?:\/[^/\s]+)+/g)) return original;
  console.warn("Shared computer error before path sanitization:", original);
  return original.replace(/(?:\/[^/\s]+)+/g, matched => matched.slice(matched.lastIndexOf("/") + 1));
};
export const sharedComputerError = error => ({ ...text(basenameMessage(error?.message ?? "Computer action failed")), isError: true });

export async function sharedPath(folder, relative = "") {
  if (typeof relative !== "string" || relative.length > 2048 || /[\\:\0]/.test(relative) || path.isAbsolute(relative) || relative.split("/").some(part => part === "..")) throw new Error("Use a relative path inside the shared folder");
  const root = await fs.realpath(folder.path);
  if (root !== folder.path) throw new Error("Shared folder moved. Choose it again in Settings.");
  let target = root;
  for (const part of relative.split("/").filter(part => part && part !== ".")) {
    target = path.join(target, part);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Symbolic links cannot be followed in shared folders"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

function listable(dir) {
  return new Promise(resolve => {
    const failed = (code, message) => resolve(Object.assign(new Error(message), { code }));
    let child;
    try {
      child = spawn("/bin/ls", [dir], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    } catch (error) { failed("EPROBE", error.message); return; }
    let said = "";
    child.stderr.on("data", chunk => { if (said.length < 4096) said += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_MAX_MS);
    timer.unref?.();
    child.once("error", error => { clearTimeout(timer); failed("EPROBE", error.message); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) return resolve(null);
      failed(/Operation not permitted/i.test(said) ? "EPERM" : /No such file/i.test(said) ? "ENOENT" : "EPROBE", said.trim() || `ls exited with ${code}`);
    });
  });
}

const probes = new Map();
function privateFolderProbe(dir, probe) {
  let outcome = probes.get(dir);
  if (!outcome) {
    outcome = Promise.resolve().then(() => probe(dir)).then(error => error ?? null, error => error ?? new Error("Probe failed"));
    probes.set(dir, outcome);
    void outcome.then(error => { if (error && probes.get(dir) === outcome) probes.delete(dir); });
  }
  return outcome;
}

const folderBlocked = name => new Error(`macOS blocked later.dog from ${name}. On the Mac, open System Settings → Privacy & Security → Files & Folders and turn on ${name} under later.dog.`);

export async function macFolderAccess(home, name, { platform = process.platform, probe = listable } = {}) {
  if (platform !== "darwin") return;
  let timer;
  const verdict = await Promise.race([
    privateFolderProbe(path.join(home, name), probe).then(error => ({ error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true }), ASK_WAIT_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
  if (verdict.pending) throw new Error(`macOS is asking on the Mac whether later.dog can open ${name}. Tell the person to click Allow on their Mac, then try again.`);
  if (verdict.error?.code === "EPERM") throw folderBlocked(name);
}

export async function primeHomeFolders(home, { platform = process.platform, probe = listable } = {}) {
  if (platform !== "darwin") return;
  for (const name of PRIVATE_FOLDERS) await privateFolderProbe(path.join(home, name), probe);
}

function privateFolderIn(relative) {
  const first = typeof relative === "string" ? relative.split("/").find(part => part && part !== ".") : undefined;
  return first ? PRIVATE_FOLDERS.find(name => name.toLowerCase() === first.toLowerCase()) : undefined;
}

export function homeRelative(folder, value) {
  if (typeof value !== "string") return value;
  const raw = value.trim();
  if (raw === "~" || raw === "~/") return "";
  if (raw.startsWith("~/")) return raw.slice(2);
  if (!path.isAbsolute(raw)) return raw;
  for (const base of new Set([folder.path, os.homedir()])) {
    const relative = path.relative(base, raw);
    if (relative === "") return "";
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative.split(path.sep).join("/");
  }
  throw new Error(OUTSIDE_HOME);
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export function sharedCommand(command, cwd, signal) {
  if (typeof command !== "string" || !command.trim() || command.length > 8000) throw new Error("Give a command of at most 8000 characters");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const script = windows
      ? `$env:PSModulePath = "$PSHOME\\Modules;$env:PSModulePath"; & "$PSHOME\\powershell.exe" -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '${Buffer.from(command, "utf16le").toString("base64")}'; exit $LASTEXITCODE`
      : command;
    const child = spawn(windows ? "powershell.exe" : "/bin/sh", windows ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-c", script], {
      cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(["PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG"].filter(key => process.env[key]).map(key => [key, process.env[key]])),
    });
    const chunks = []; let bytes = 0; let reason;
    const stop = message => { reason = message; killTree(child); };
    const abort = () => stop("Computer access was revoked or the requesting turn ended. Inspect the result before retrying.");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Command timed out after 30 seconds; inspect before retrying."), 30_000);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= LIMIT) chunks.push(chunk); else stop("Command output exceeded the limit");
    });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); if (reason) reject(new Error(reason)); else resolve(text({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") })); });
  });
}

export function createSharedCua(connection) {
  const child = spawn(connection.mcpCommand, connection.mcpArgs, {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...connection.mcpEnv },
  });
  let sequence = 0; let closed = false; let bytes = 0;
  const pending = new Map();
  const fail = error => { closed = true; for (const item of pending.values()) item.reject(error); pending.clear(); child.kill(); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => fail(new Error("Computer-control transport closed")));
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4_000_000) fail(new Error("Computer-control response exceeded limit")); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); bytes = 0;
    if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
  });
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) return reject(new Error("Computer control is disconnected"));
    const id = ++sequence;
    const abort = () => fail(new Error("Computer control stopped. An action already admitted by the driver may have completed."));
    const timer = setTimeout(abort, 30_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    pending.set(id, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const ready = request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "laterdog-shared-desktop", version: "1" } }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  ready.catch(() => {});
  return {
    async call(operation, signal) {
      await ready; signal.throwIfAborted();
      if (operation.action === "computer_tools") {
        const listed = await request("tools/list", {}, signal);
        return text({ ...listed, tools: lentScreenToolListing(listed?.tools) });
      }
      if (typeof operation.tool_name !== "string" || !operation.tool_name) throw new Error("Choose a tool from computer_tools first");
      const lent = lentScreenArguments(operation.tool_name, operation.arguments);
      if (lent.error) throw new Error(lent.error);
      return request("tools/call", { name: operation.tool_name, arguments: lent.arguments }, signal);
    },
    close() { lines.close(); fail(new Error("Computer sharing stopped")); },
  };
}

export async function commandFolder(grant, cwd, { home = os.homedir() } = {}) {
  const base = grant.folders[0]?.path ?? home;
  if (cwd === undefined || cwd === "") return base;
  if (typeof cwd !== "string" || cwd.length > 2048 || cwd.includes("\0")) throw new Error("Give cwd as a folder path on the Mac");
  const trimmed = cwd.trim();
  const target = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : path.isAbsolute(trimmed) ? trimmed : path.join(base, trimmed);
  let real;
  try { real = await fs.realpath(target); } catch (error) { throw absent(error) ? new Error(`There's no folder ${trimmed} on this Mac`) : error; }
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${trimmed} is a file, not a folder`);
  return real;
}

async function commandOperation(grant, operation, signal, access) {
  const runner = access.commands ?? commands;
  if (operation.action === "run_command") {
    const cwd = await commandFolder(grant, operation.cwd, access);
    if (grant.home === true && typeof operation.command === "string") {
      const home = grant.folders[0]?.path ?? os.homedir();
      for (const name of PRIVATE_FOLDERS) {
        if (new RegExp(`\\b${name}\\b`, "i").test(operation.command) || privateFolderIn(path.relative(home, cwd).split(path.sep).join("/")) === name) await macFolderAccess(home, name, access);
      }
    }
    return text(await runner.start({ command: operation.command, cwd, waitSeconds: operation.wait_seconds, signal }));
  }
  if (operation.action === "command_output") return text(await runner.output({ id: operation.command_id, waitSeconds: operation.wait_seconds, signal }));
  if (operation.action === "command_input") return text(runner.input({ id: operation.command_id, input: operation.input, close: operation.close_input === true }));
  return text(await runner.stop({ id: operation.command_id }));
}

export async function executeSharedOperation(grant, operation, signal, cua, access = {}) {
  signal.throwIfAborted();
  if (grant.enabled !== true) throw new Error("Computer sharing is off");
  if (COMMAND_ACTIONS.has(operation.action)) {
    if (grant.terminal !== true) throw new Error("Terminal access is not enabled for this server");
    return commandOperation(grant, operation, signal, access);
  }
  if (["computer_tools", "computer_call"].includes(operation.action)) {
    if (grant.computer !== true) throw new Error("Computer control is not enabled for this server");
    return (await cua()).call(operation, signal);
  }
  if (!FILE_ACTIONS.has(operation.action)) throw new Error("Unsupported shared-computer operation");
  const folder = grant.folders.find(entry => entry.id === operation.folder_id);
  if (!folder) throw new Error("This folder has not been shared with this server");
  try {
    return await fileOperation(grant, folder, operation, signal, access);
  } catch (error) {
    if ((access.platform ?? process.platform) !== "darwin" || error?.code !== "EPERM") throw error;
    let name;
    try { name = grant.home === true ? privateFolderIn(homeRelative(folder, operation.path)) : undefined; } catch {}
    if (!name) throw new Error(MAC_BLOCKED);
    probes.delete(path.join(folder.path, name));
    throw folderBlocked(name);
  }
}

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

async function readWhole(file, size) {
  const buffer = Buffer.alloc(size);
  let total = 0;
  while (total < size) {
    const { bytesRead } = await file.read(buffer, total, size - total, total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function writeWhole(file, data, signal) {
  for (let offset = 0; offset < data.length;) {
    signal.throwIfAborted();
    const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
    if (!bytesWritten) throw new Error("File write did not make progress; inspect before retrying");
    offset += bytesWritten;
  }
  await file.truncate(data.length);
  await file.sync();
}

async function editShared(folder, relative, target, protectedRoots, operation, signal) {
  if (folder.write !== true) throw new Error("This folder is read-only");
  if (insideGitInternals(folder.path, relative ?? "")) throw new Error(GIT_INTERNALS);
  const { old_text: before, new_text: after } = operation;
  if (typeof before !== "string" || !before) throw new Error("Give old_text: the exact text to replace");
  if (typeof after !== "string") throw new Error("Give new_text: the text to put in its place");
  if (before === after) throw new Error("old_text and new_text are the same, so nothing would change");
  const file = await fs.open(target, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error("Only regular, single-link files can be shared");
    if (stat.size > BigInt(LENT_FILE_MAX)) throw new Error("Files over 25 MiB can't be edited here");
    await sharedPath(folder, relative);
    const named = await fs.lstat(target, { bigint: true });
    if (named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw new Error("The file changed while opening it; retry after inspecting the folder");
    if (protectedRoots.has(`${stat.dev}:${stat.ino}`)) throw new Error(PROTECTED);
    const current = await readWhole(file, Number(stat.size));
    if (current.subarray(0, 8192).includes(0)) throw new Error("This looks like a binary file; edit_file changes text files only");
    const original = current.toString("utf8");
    const found = occurrences(original, before);
    if (found === 0) throw new Error("old_text wasn't found. Read the file again and copy the text exactly, including spaces and line breaks.");
    if (found > 1 && operation.replace_all !== true) throw new Error(`old_text appears ${found} times. Add more of the surrounding text so it's unique, or pass replace_all to change all ${found}.`);
    const edited = operation.replace_all === true ? original.split(before).join(after) : original.replace(before, () => after);
    const data = Buffer.from(edited, "utf8");
    await writeWhole(file, data, signal);
    return { edited: true, replacements: operation.replace_all === true ? found : 1, bytes: data.length, sha256: hash(data) };
  } finally { await file.close(); }
}

async function deleteShared(folder, relative, target, protectedRoots, signal) {
  if (folder.write !== true) throw new Error("This folder is read-only");
  if (insideGitInternals(folder.path, relative ?? "")) throw new Error(GIT_INTERNALS);
  if (target === folder.path) throw new Error("Give the path of a file or folder inside the shared folder");
  const info = await fs.lstat(target, { bigint: true });
  if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be followed in shared folders");
  if (protectedRoots.has(`${info.dev}:${info.ino}`)) throw new Error(PROTECTED);
  signal.throwIfAborted();
  if (info.isDirectory()) {
    try { await fs.rmdir(target); } catch (error) {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") throw new Error("That folder isn't empty. Delete what's inside first, or use run_command if you mean to remove the whole folder.");
      throw error;
    }
    return { deleted: true, kind: "folder" };
  }
  await fs.unlink(target);
  return { deleted: true, kind: "file" };
}

async function fileOperation(grant, folder, operation, signal, access) {
  const relative = grant.home === true ? homeRelative(folder, operation.path) : operation.path;
  if (grant.home === true) {
    const name = privateFolderIn(relative);
    if (name) await macFolderAccess(folder.path, name, access);
    signal.throwIfAborted();
  }
  const target = await sharedPath(folder, relative);
  const protectedRoots = await protectedIdentities(grant.protectedPaths);
  await assertOutsideProtected(protectedRoots, target);
  signal.throwIfAborted();
  if (operation.action === "search_files") {
    return text(await searchFolder({
      target, protectedPaths: grant.protectedPaths, pattern: operation.pattern, glob: operation.glob,
      ignoreCase: operation.ignore_case === true, maxResults: operation.max_results, signal,
    }));
  }
  if (operation.action === "delete_file") return text(await deleteShared(folder, relative, target, protectedRoots, signal));
  if (operation.action === "edit_file") return text(await editShared(folder, relative, target, protectedRoots, operation, signal));
  if (operation.action === "list_files") {
    const entries = await fs.readdir(target, { withFileTypes: true });
    const shown = await Promise.all(entries.slice(0, 200).map(async entry => {
      if (entry.isSymbolicLink()) return { name: entry.name, type: "blocked-link" };
      let identity;
      try { identity = await identify(path.join(target, entry.name)); } catch {}
      if (identity !== undefined && protectedRoots.has(identity)) return { name: entry.name, type: "protected" };
      return { name: entry.name, type: entry.isDirectory() ? "directory" : "file" };
    }));
    return text({ entries: shown, truncated: entries.length > 200 });
  }
  const write = operation.action === "write_file";
  const ranged = !write && (operation.offset !== undefined || operation.length !== undefined);
  if (ranged && (!Number.isSafeInteger(operation.offset ?? 0) || (operation.offset ?? 0) < 0 || !Number.isSafeInteger(operation.length ?? LIMIT) || (operation.length ?? LIMIT) < 1 || (operation.length ?? LIMIT) > LIMIT)) {
    throw new Error("Read a part with a whole-number offset and a length of at most 256 KiB");
  }
  if (write && folder.write !== true) throw new Error("This folder is read-only");
  if (write && insideGitInternals(folder.path, relative ?? "")) throw new Error(GIT_INTERNALS);
  let data;
  if (write) {
    if (typeof operation.content !== "string") throw new Error("Give file content to write");
    data = Buffer.from(operation.content, operation.encoding === "base64" ? "base64" : "utf8");
    if (data.length > LIMIT) throw new Error("Files are limited to 256 KiB per operation");
  }
  const flags = (write ? operation.expected_sha256 ? constants.O_RDWR : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await fs.open(target, flags, 0o600);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error("Only regular, single-link files can be shared");
    if (stat.size > BigInt(ranged ? LENT_FILE_MAX : LIMIT)) {
      throw new Error(ranged ? "Files over 25 MiB can't be shared" : "Files over 256 KiB are read in parts: give offset and length (up to 256 KiB each)");
    }
    await sharedPath(folder, relative);
    const named = await fs.lstat(target, { bigint: true });
    if (named.ino !== stat.ino || named.dev !== stat.dev || named.isSymbolicLink()) throw new Error("The file changed while opening it; retry after inspecting the folder");
    if (protectedRoots.has(`${stat.dev}:${stat.ino}`)) throw new Error(PROTECTED);
    await assertOutsideProtected(protectedRoots, target);
    let current = Buffer.alloc(0);
    if (ranged) {
      const offset = operation.offset ?? 0;
      const size = Number(stat.size);
      const length = Math.max(0, Math.min(operation.length ?? LIMIT, size - offset));
      const part = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await file.read(part, read, length - read, offset + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      signal.throwIfAborted();
      const chunk = part.subarray(0, read);
      return text({ content: chunk.toString(operation.encoding === "base64" ? "base64" : "utf8"), encoding: operation.encoding ?? "utf8", bytes: chunk.length, offset, size, sha256: hash(chunk) });
    }
    if (!write || operation.expected_sha256) {
      const buffer = Buffer.alloc(LIMIT + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > LIMIT) throw new Error("File grew beyond the 256 KiB limit");
      current = buffer.subarray(0, total);
    }
    if (write) {
      if (operation.expected_sha256 && hash(current) !== operation.expected_sha256) throw new Error("File changed. Read it again before overwriting it.");
      signal.throwIfAborted();
      for (let offset = 0; offset < data.length;) {
        signal.throwIfAborted();
        const { bytesWritten } = await file.write(data, offset, data.length - offset, offset);
        if (!bytesWritten) throw new Error("File write did not make progress; inspect before retrying");
        offset += bytesWritten;
      }
      await file.truncate(data.length); await file.sync();
      return text({ written: true, bytes: data.length, sha256: hash(data) });
    }
    signal.throwIfAborted();
    return text({ content: current.toString(operation.encoding === "base64" ? "base64" : "utf8"), encoding: operation.encoding ?? "utf8", bytes: current.length, sha256: hash(current) });
  } finally { await file.close(); }
}
