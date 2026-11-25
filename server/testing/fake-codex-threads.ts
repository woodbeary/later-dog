import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeCodexTurn {
  id: string;
  prompt: string;
  reply: string;
}

export class FakeCodexThreads {
  private count = 0;
  private readonly dir: string;
  private readonly options: { seenLog?: string; forkLog?: string; forkIgnoresTurn?: boolean };

  constructor(dir: string, options: { seenLog?: string; forkLog?: string; forkIgnoresTurn?: boolean } = {}) {
    this.dir = dir;
    this.options = options;
    mkdirSync(dir, { recursive: true });
  }

  start(): { id: string; turns: FakeCodexTurn[] } {
    const id = `codex-thread-${process.pid}-${++this.count}`;
    this.save(id, []);
    return { id, turns: [] };
  }

  resume(id: string): { id: string; turns: FakeCodexTurn[] } | null {
    const turns = this.read(id);
    return turns ? { id, turns } : null;
  }

  fork(id: string, lastTurnId: string | undefined): { id: string; turns: FakeCodexTurn[] } | null {
    const source = this.read(id);
    if (!source) return null;
    const end = lastTurnId === undefined || this.options.forkIgnoresTurn ? source.length - 1 : source.findIndex((turn) => turn.id === lastTurnId);
    if (end === -1) return null;
    const forked = { id: `codex-thread-${process.pid}-${++this.count}`, turns: source.slice(0, end + 1) };
    this.save(forked.id, forked.turns);
    if (this.options.forkLog) appendFileSync(this.options.forkLog, `${JSON.stringify({ from: id, lastTurnId: lastTurnId ?? null, thread: forked.id, kept: forked.turns.length })}\n`);
    return forked;
  }

  beginTurn(threadId: string, prompt: string): FakeCodexTurn {
    const turns = this.read(threadId) ?? [];
    if (this.options.seenLog) appendFileSync(this.options.seenLog, `${JSON.stringify({ thread: threadId, prompt, history: turns.map(({ prompt: asked, reply }) => ({ prompt: asked, reply })) })}\n`);
    const words = prompt.trim().split("\n").at(-1)?.slice(0, 60) ?? "";
    const turn = { id: `turn-${process.pid}-${++this.count}`, prompt, reply: `Reply to ${words}` };
    this.save(threadId, [...turns, turn]);
    return turn;
  }

  private read(id: string): FakeCodexTurn[] | null {
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")) as FakeCodexTurn[]; } catch { return null; }
  }

  private save(id: string, turns: FakeCodexTurn[]): void {
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(turns));
  }
}
