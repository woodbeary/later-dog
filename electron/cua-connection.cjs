const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

function createCuaConnectionStore({
  getUserData,
  fileSystem = fs,
  temporaryId = randomUUID,
  processId = process.pid,
  fileName = "cua-connection.json",
}) {
  let connection = null;

  return Object.freeze({
    get() {
      return connection;
    },

    persist(next) {
      const userData = getUserData();
      fileSystem.mkdirSync(userData, { recursive: true });
      const descriptorPath = path.join(userData, fileName);
      const temporaryPath = `${descriptorPath}.${processId}.${temporaryId()}.tmp`;
      let handle;

      try {
        try {
          fileSystem.chmodSync(userData, 0o700);
        } catch {}
        handle = fileSystem.openSync(temporaryPath, "wx", 0o600);
        fileSystem.writeFileSync(handle, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        fileSystem.fsyncSync(handle);
        fileSystem.closeSync(handle);
        handle = undefined;
        fileSystem.renameSync(temporaryPath, descriptorPath);
        try {
          fileSystem.chmodSync(descriptorPath, 0o600);
        } catch {}
      } catch (error) {
        if (handle !== undefined) {
          try {
            fileSystem.closeSync(handle);
          } catch {}
        }
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {}
        throw error;
      }

      connection = next;
      return connection;
    },
  });
}

module.exports = { createCuaConnectionStore };
