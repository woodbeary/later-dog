import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LOCAL_CONTROL_TOKEN_FILE = "local-control-token";
export const LOCAL_CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function localControlTokenPath(userData) {
  return path.join(userData, LOCAL_CONTROL_TOKEN_FILE);
}

export function writeLocalControlToken(userData, { generate = () => randomBytes(32).toString("base64url"), platform = process.platform } = {}) {
  const token = generate();
  if (!LOCAL_CONTROL_TOKEN_PATTERN.test(token)) throw new Error("invalid local control token");
  const file = localControlTokenPath(userData);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  const pending = `${file}.${process.pid}.pending`;
  try {
    fs.writeFileSync(pending, `${token}\n`, { mode: 0o600, flag: "w" });
    if (platform !== "win32") fs.chmodSync(pending, 0o600);
    fs.renameSync(pending, file);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    throw error;
  }
  return { token, file };
}

export function removeLocalControlToken(file, token) {
  try {
    if (fs.readFileSync(file, "utf8").trim() === token) fs.rmSync(file, { force: true });
  } catch {}
}

export function startLocalControlToken(userData, log, options) {
  try {
    return writeLocalControlToken(userData, options);
  } catch (error) {
    log(`local tools token could not be written; Claude Code, Codex and scripts will need a paired session: ${error?.message ?? error}`);
    return null;
  }
}
