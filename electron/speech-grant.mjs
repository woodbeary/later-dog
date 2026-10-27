import fs from "node:fs";
import path from "node:path";

const grantFile = (userData) => path.join(userData, "speech-grant.json");

export function speechEverGranted(userData) {
  try {
    return JSON.parse(fs.readFileSync(grantFile(userData), "utf8"))?.granted === true;
  } catch {
    return false;
  }
}

export function rememberSpeechGranted(userData) {
  const file = grantFile(userData);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ granted: true }, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

export function forgetSpeechGranted(userData) {
  try {
    fs.unlinkSync(grantFile(userData));
  } catch {}
}
