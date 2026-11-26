import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOutOfSpace } from "./plain-error.ts";

const reserveBytes = 2 * 1024 * 1024;

export class ReplyDiskReserve {
  private fd: number | undefined;
  private checkAfter = 0;

  prepare(directory: string): void {
    if (this.fd !== undefined || Date.now() < this.checkAfter) return;
    this.checkAfter = Date.now() + 60_000;
    let fd: number | undefined;
    try {
      const disk = statfsSync(directory);
      if (disk.bavail * disk.bsize < 4 * reserveBytes) return;
      const file = join(directory, `.reply-reserve-${randomUUID()}`);
      fd = openSync(file, "wx+", 0o600);
      unlinkSync(file);
      writeFileSync(fd, Buffer.alloc(reserveBytes));
      fsyncSync(fd);
      this.fd = fd;
    } catch {
      if (fd !== undefined) closeSync(fd);
    }
  }

  save(write: () => void): void {
    try {
      write();
    } catch (error) {
      if (this.fd === undefined || !isOutOfSpace(error)) throw error;
      this.close();
      write();
    }
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    this.checkAfter = 0;
  }
}
