import { folderAction, type FolderRun } from "../laterdog/dog-folder.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const DOG_FOLDER_PATH = "/api/internal/dog-folder";

export interface DogFolderRouteDeps {
  owns(botId: string, threadId: string): boolean;
  folders(botId: string, threadId: string): string[];
  run: FolderRun;
  ready?(botId: string, threadId: string): Promise<void>;
}

const CHANGES = new Set(["write", "edit", "delete"]);

export function createDogFolderRoute(deps: DogFolderRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, sender, threadId, readBody }) => {
    if (method !== "POST" || path !== DOG_FOLDER_PATH) return PASS;
    if (!deps.owns(sender.id, threadId)) return json(res, 403, { error: "source conversation does not belong to sender" });
    const body = await readBody();
    if (deps.ready && CHANGES.has(String(body?.action))) {
      try { await deps.ready(sender.id, threadId); }
      catch { return json(res, 503, { error: "Your computer could not start, so your files were left unchanged. Try again in a minute." }); }
    }
    const answer = await folderAction(body && typeof body === "object" ? body : {}, deps.folders(sender.id, threadId), deps.run);
    return json(res, answer.status, answer.error ? { error: answer.error } : { text: answer.text });
  };
}
