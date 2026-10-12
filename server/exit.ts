export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  const flushed = (stream: NodeJS.WriteStream) => new Promise<void>((done) => stream.write("", () => done()));
  void Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => process.exit(code));
}
