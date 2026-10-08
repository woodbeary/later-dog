import { readFileSync } from "node:fs";
import { WorkspaceStore } from "./store.ts";

export async function deliverOutbox(store: WorkspaceStore, origin: string, tokenFile?: string, fetcher: typeof fetch = fetch): Promise<void> {
  const url = new URL(origin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !(url.protocol === "https:" || url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Workspace wakeups require a secure origin");
  const token = tokenFile ? readFileSync(tokenFile,"utf8").trim() : undefined;
  const rows = store.db.prepare("SELECT id,document FROM outbox WHERE delivered=0 ORDER BY id LIMIT 10").all() as { id: number; document: string }[];
  for (const row of rows) {
    const notification = JSON.parse(row.document) as { botId: string; threadId: string; sendId: string; text: string };
    const response = await fetcher(`${url.origin}/api/bots/${encodeURIComponent(notification.botId)}/messages`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(process.env.LATERDOG_DESKTOP_OWNER_TOKEN ? { "X-LaterDog-Desktop-Owner": process.env.LATERDOG_DESKTOP_OWNER_TOKEN } : {}) },
      body: JSON.stringify({ threadId: notification.threadId, sendId: notification.sendId, text: notification.text }), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Workspace wakeup is pending (${response.status}); job state and send identity are retained`);
    store.db.prepare("UPDATE outbox SET delivered=1 WHERE id=?").run(row.id);
  }
}
