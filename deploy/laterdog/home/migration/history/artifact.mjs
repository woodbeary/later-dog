import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
export function writeOnce(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID() + ".part";
  writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
  try {
    try {
      linkSync(temp, path);
    } catch (error) {
      if (
        error.code !== "EEXIST" ||
        !Buffer.from(data).equals(readFileSync(path))
      )
        throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

export function saveJson(path, value) {
  writeOnce(path, Buffer.from(JSON.stringify(value)));
}
