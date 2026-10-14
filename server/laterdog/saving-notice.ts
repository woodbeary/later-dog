const OUT_OF_SPACE = new Set(["ENOSPC", "EDQUOT"]);
const NOT_ALLOWED = new Set(["EACCES", "EPERM", "EROFS"]);

function thisComputer(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Your Mac";
  if (platform === "win32") return "Your PC";
  return "This computer";
}

export function savingNotice(error: unknown, platform: NodeJS.Platform = process.platform): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && OUT_OF_SPACE.has(code)) {
    return `${thisComputer(platform)} is almost out of space, so later.dog couldn't save part of this chat. Free up some space and it will keep saving.`;
  }
  if (typeof code === "string" && NOT_ALLOWED.has(code)) {
    return "later.dog isn't allowed to write to its data folder, so it couldn't save part of this chat. Check that folder's permissions and it will keep saving.";
  }
  return "later.dog couldn't save part of this chat. It will keep trying.";
}

export class SavingNoticeOnce {
  private readonly told = new Set<string>();

  next(threadId: string, error: unknown, platform?: NodeJS.Platform): string | undefined {
    if (this.told.has(threadId)) return undefined;
    this.told.add(threadId);
    return savingNotice(error, platform);
  }
}
