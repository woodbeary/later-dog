import fs from "node:fs";
import path from "node:path";

const KEEP = 500;
// oxlint-disable-next-line no-control-regex
const clean = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, max) : undefined;

export function describeSharedOperation(grant, operation) {
  switch (operation?.action) {
    case "list_files":
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file":
    case "search_files": {
      const folder = grant?.folders?.find?.(entry => entry.id === operation.folder_id);
      const where = typeof operation.path === "string" && operation.path ? `/${operation.path}` : "";
      const looking = operation.action === "search_files" && typeof operation.pattern === "string" ? ` for ${operation.pattern}` : "";
      return clean(`${folder?.name ?? "unknown folder"}${where}${looking}`, 300);
    }
    case "run_command": return clean(operation.cwd ? `${operation.command} (in ${operation.cwd})` : operation.command, 300);
    case "command_output":
    case "command_input":
    case "command_stop": return clean(`command ${String(operation.command_id ?? "").slice(0, 8)}`, 60);
    case "computer_call": return clean(operation.tool_name, 100);
    default: return "";
  }
}

export function createLendingActivity(file, { now = Date.now, keep = KEEP } = {}) {
  const previous = `${file}.1`;
  const read = name => {
    try { return fs.readFileSync(name, "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  };
  let count = null;
  const append = line => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    count ??= read(file).length;
    if (count >= keep) { fs.renameSync(file, previous); count = 0; }
    const handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(handle, `${line}\n`); } finally { fs.closeSync(handle); }
    count++;
  };
  return {
    record({ env, action, detail, ok, error }) {
      const entry = {
        at: now(), server: clean(env?.name, 120) ?? "", origin: clean(env?.origin, 300) ?? "",
        action: clean(action, 40) ?? "", detail: clean(detail, 300) ?? "", ok: ok === true,
        ...(ok === true ? {} : { error: clean(error, 200) ?? "" }),
      };
      try { append(JSON.stringify(entry)); } catch { count = null; }
      return entry;
    },
    list(limit = 100) {
      const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, keep * 2) : 100;
      const entries = [];
      for (const line of [...read(previous), ...read(file)].reverse()) {
        if (entries.length >= count) break;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry.at === "number" && typeof entry.action === "string") entries.push(entry);
        } catch {}
      }
      return entries;
    },
  };
}
