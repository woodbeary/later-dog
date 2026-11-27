import { validLetter, type InboxLetter, type LetterState, type StoredLetter } from "../../../../shared/dog-object-protocol.ts";

interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface DogInboxPort {
  inboxPut(letter: InboxLetter): Promise<StoredLetter | null>;
  inboxPull(after: number, limit: number): Promise<StoredLetter[]>;
  inboxAck(clientIds: string[]): Promise<number>;
  inboxStatus(clientIds: string[]): Promise<Record<string, LetterState>>;
}

export const DELIVERED_KEPT_MS = 7 * 24 * 60 * 60_000;
export const MAX_WAITING_LETTERS = 2_000;

function stored(row: Record<string, unknown>): StoredLetter {
  return {
    seq: Number(row.seq),
    clientId: String(row.client_id),
    from: String(row.from_dog),
    fromChat: String(row.from_chat),
    toChat: row.to_chat === null ? null : String(row.to_chat),
    text: String(row.text),
    replyTo: row.reply_to === null ? null : String(row.reply_to),
    at: Number(row.at),
    state: String(row.state) as LetterState,
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
  };
}

export function dogInbox(sql: Sql, now: () => number = Date.now): DogInboxPort {
  sql.exec(`CREATE TABLE IF NOT EXISTS dog_inbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL UNIQUE,
    from_dog TEXT NOT NULL,
    from_chat TEXT NOT NULL,
    to_chat TEXT,
    text TEXT NOT NULL,
    reply_to TEXT,
    at INTEGER NOT NULL,
    state TEXT NOT NULL,
    delivered_at INTEGER
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS dog_inbox_waiting ON dog_inbox (state, seq)");
  const byClient = (clientId: string) => sql.exec("SELECT * FROM dog_inbox WHERE client_id = ?", clientId).toArray()[0];
  return {
    async inboxPut(letter) {
      if (!validLetter(letter)) return null;
      const held = byClient(letter.clientId);
      if (held) return stored(held);
      const waiting = Number(sql.exec("SELECT COUNT(*) AS n FROM dog_inbox WHERE state = 'accepted'").toArray()[0]?.n ?? 0);
      if (waiting >= MAX_WAITING_LETTERS) return null;
      sql.exec(
        "INSERT INTO dog_inbox (client_id, from_dog, from_chat, to_chat, text, reply_to, at, state, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', NULL)",
        letter.clientId, letter.from, letter.fromChat, letter.toChat, letter.text, letter.replyTo, letter.at,
      );
      sql.exec("DELETE FROM dog_inbox WHERE state = 'delivered' AND delivered_at < ?", now() - DELIVERED_KEPT_MS);
      return stored(byClient(letter.clientId)!);
    },
    async inboxPull(after, limit) {
      const size = Math.max(1, Math.min(200, Math.floor(limit)));
      return sql.exec("SELECT * FROM dog_inbox WHERE state = 'accepted' AND seq > ? ORDER BY seq LIMIT ?", Math.max(0, Math.floor(after)), size)
        .toArray().map(stored);
    },
    async inboxAck(clientIds) {
      let acked = 0;
      const at = now();
      for (const clientId of clientIds) {
        acked += sql.exec("UPDATE dog_inbox SET state = 'delivered', delivered_at = ? WHERE client_id = ? AND state = 'accepted' RETURNING seq", at, clientId).toArray().length;
      }
      return acked;
    },
    async inboxStatus(clientIds) {
      const states: Record<string, LetterState> = {};
      for (const clientId of clientIds) {
        const held = byClient(clientId);
        if (held) states[clientId] = String(held.state) as LetterState;
      }
      return states;
    },
  };
}
