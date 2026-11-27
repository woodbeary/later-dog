import { previousProjectComputer } from "../computers.ts";
import { workFolderAuthority, workFolderBaseUrl } from "../../shared/work-folder-store.ts";
import { type ProjectAccessLoss } from "./project-access.ts";
import { ENGINE_FOLDER_STATE } from "./engine-folder-sync.ts";
import { prepareEngineFolderTools } from "./engine-computer.ts";
import { GUEST_FOLDER_HELPER } from "./engine-folder-process.ts";
import { projectFolderId } from "./work-folder-locations.ts";

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

export async function retireMemberProjects(loss: ProjectAccessLoss[], origin: string, bootstrap: string) {
  for (const { member, owner, path } of loss) {
    const id = projectFolderId(path);
    const url = workFolderBaseUrl(origin, owner, id);
    const headers = { authorization: "Bearer " + (await workFolderAuthority(bootstrap, owner, id)) };
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const pageUrl = new URL(url + "/grantees/" + member);
      if (cursor) pageUrl.searchParams.set("cursor", cursor);
      const response = await fetch(pageUrl, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("The previous project computers could not be verified.");
      const page = (await response.json()) as { guests: string[]; cursor?: string };
      for (const guest of page.guests) {
        if (!/^cmp_[a-z0-9]{1,64}$/.test(guest)) throw new Error("Invalid project computer identity.");
        const box = await previousProjectComputer(member, guest);
        if (box) {
          await prepareEngineFolderTools(box);
          const identity = Buffer.from(JSON.stringify({ uri: url, guest })).toString("base64url");
          const command = ["node", GUEST_FOLDER_HELPER, "release-member", path, ENGINE_FOLDER_STATE, identity]
            .map(quote)
            .join(" ");
          const result = await box.exec(command, 10 * 60_000);
          if (result.exitCode !== 0 || !result.stdout.trim().endsWith('{"released":true}'))
            throw Object.assign(
              new Error("The dog's shared project checkout could not be safely saved and released."),
              {
                status: 409,
              },
            );
        }
        const revoked = await fetch(url + "/revoke", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ guestId: guest, granteeBotId: member }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!revoked.ok) throw new Error("The previous computer’s shared project token could not be retired.");
      }
      cursor = page.cursor;
      if (cursor && seen.has(cursor)) throw new Error("Project computer inventory did not advance.");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
}
