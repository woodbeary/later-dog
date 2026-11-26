export interface RecoveryState {
  version: number;
  recoverable: number;
  head: string | null;
  cards?: number;
}
export type RecoveryQuery =
  | "native.recover"
  | "messages.commandHead"
  | "messages.hasCards";
export class HistoryRecovery {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS history_recovery (generation TEXT NOT NULL,thread TEXT NOT NULL,version INTEGER NOT NULL,recoverable INTEGER NOT NULL,head TEXT,PRIMARY KEY(generation,thread))",
    );
    if (
      !sql
        .exec<{ name: string }>("PRAGMA table_info(history_recovery)")
        .toArray()
        .some((row) => row.name === "cards")
    )
      sql.exec("ALTER TABLE history_recovery ADD COLUMN cards INTEGER");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS history_recovery_intents (generation TEXT NOT NULL,thread TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(generation,thread,token))",
    );
  }
  initialize(generation: string, thread: string) {
    this.sql.exec(
      "INSERT OR IGNORE INTO history_recovery VALUES(?,?,0,0,NULL,0)",
      generation,
      thread,
    );
  }
  reserve(generation: string, thread: string, token: string) {
    this.sql.exec(
      "INSERT INTO history_recovery_intents VALUES(?,?,?)",
      generation,
      thread,
      token,
    );
  }
  private save(generation: string, thread: string, state: RecoveryState) {
    this.sql.exec(
      "INSERT INTO history_recovery VALUES(?,?,?,?,?,?) ON CONFLICT(generation,thread) DO UPDATE SET version=excluded.version,recoverable=excluded.recoverable,head=excluded.head,cards=excluded.cards WHERE excluded.version>=history_recovery.version",
      generation,
      thread,
      state.version,
      state.recoverable,
      state.head,
      state.cards ?? null,
    );
  }
  settle(
    generation: string,
    thread: string,
    token: string,
    state: RecoveryState,
  ) {
    const pending = this.sql
      .exec(
        "DELETE FROM history_recovery_intents WHERE generation=? AND thread=? AND token=? RETURNING token",
        generation,
        thread,
        token,
      )
      .toArray();
    if (pending.length) this.save(generation, thread, state);
  }
  fence(generation: string, thread: string, state: RecoveryState) {
    this.sql.exec(
      "DELETE FROM history_recovery_intents WHERE generation=? AND thread=?",
      generation,
      thread,
    );
    this.sql.exec(
      "DELETE FROM history_recovery WHERE generation=? AND thread=?",
      generation,
      thread,
    );
    this.save(generation, thread, state);
  }
  page(
    generation: string,
    operation: RecoveryQuery,
    after: string | undefined,
    limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256)
      throw Error("Invalid history recovery page size");
    const condition =
      operation === "native.recover"
        ? "recoverable=1"
        : operation === "messages.hasCards"
          ? "cards IS NULL OR cards=1"
          : "head IS NOT NULL";
    const rows = this.sql
      .exec<{
        thread: string;
        uncertain: number;
        head: string | null;
        cards: number | null;
      }>(
        "WITH candidates AS (SELECT s.thread,r.head,r.recoverable,r.cards,(r.thread IS NULL OR EXISTS (SELECT 1 FROM history_recovery_intents i WHERE i.generation=s.generation AND i.thread=s.thread)) uncertain FROM shards s LEFT JOIN history_recovery r ON r.generation=s.generation AND r.thread=s.thread WHERE s.generation=? AND s.thread>?) SELECT thread,uncertain,head,cards FROM candidates WHERE uncertain OR " +
          condition +
          " ORDER BY thread LIMIT ?",
        generation,
        after ?? "",
        limit + 1,
      )
      .toArray();
    const more = rows.length > limit;
    if (more) rows.pop();
    return { rows, next: more ? rows.at(-1)!.thread : null };
  }
}
