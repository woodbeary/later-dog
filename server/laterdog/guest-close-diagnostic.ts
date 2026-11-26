const classes: ReadonlyArray<readonly [string, RegExp]> = [
  ["module-missing", /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/i],
  ["invalid-module", /SyntaxError|ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/i],
  ["invalid-runtime", /ReferenceError|TypeError|ERR_INVALID_ARG_TYPE/i],
  ["missing-file", /ENOENT|No such file or directory/i],
  ["permission", /EACCES|EPERM|Permission denied/i],
  ["disk-full", /ENOSPC|No space left on device/i],
  ["memory", /out of memory|heap limit|ENOMEM/i],
  ["socket", /EADDRINUSE|ECONNRESET|EPIPE|connection refused|listen EINVAL/i],
  ["engine-setup", /did not confirm the engine started|engine relay stopped/i],
];
export class GuestCloseDiagnostic {
  private tail = "";
  category = "no-diagnostic";
  receive(chunk: Buffer | string) {
    const data = typeof chunk === "string" ? chunk.slice(-2048) : chunk.subarray(-2048).toString("utf8");
    const sample = this.tail + data;
    this.tail = sample.slice(-128);
    const found = classes.find(([, pattern]) => pattern.test(sample));
    if (
      found &&
      (this.category === "no-diagnostic" || this.category === "unclassified" || this.category === "engine-setup")
    )
      this.category = found[0];
    else if (this.category === "no-diagnostic" && sample.trim()) this.category = "unclassified";
  }
}
