import type { Message } from "../store.ts";
export type HistoryTail = { messages: Message[]; activeLeafId: string | null; hasMore: boolean };
type State = {
  attention?: Message[];
  attentionBytes?: number;
  summary?: HistoryTail;
  page?: { raw: string; bytes: number; limit: number };
};
export class HistorySnapshotCache {
  private states = new Map<string, State>();
  private retained = 0;
  private attentionBytes = 0;
  private dropAttention(state: State) {
    this.attentionBytes -= state.attentionBytes ?? 0;
    delete state.attention;
    delete state.attentionBytes;
  }
  saveAttention(state: State, rows: Message[]) {
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    this.dropAttention(state);
    if (bytes > 128 * 1024) return;
    state.attention = rows;
    state.attentionBytes = bytes;
    this.attentionBytes += bytes;
    if (this.attentionBytes > 4 * 1024 * 1024)
      for (const item of this.states.values()) {
        this.dropAttention(item);
        if (this.attentionBytes < 3 * 1024 * 1024) break;
      }
  }
  private dropPage(state: State) {
    if (state.page) {
      this.retained -= state.page.bytes;
      delete state.page;
    }
  }
  invalidate(thread: string) {
    const state = this.states.get(thread);
    if (state) {
      this.dropPage(state);
      this.dropAttention(state);
    }
    this.states.delete(thread);
  }
  witness(thread: string): State {
    let state = this.states.get(thread);
    if (state) {
      this.states.delete(thread);
      this.states.set(thread, state);
      return state;
    }
    state = {};
    this.states.set(thread, state);
    if (this.states.size > 4096) this.invalidate(this.states.keys().next().value!);
    return state;
  }
  valid(thread: string, state: State) {
    return this.states.get(thread) === state;
  }
  get(state: State, limit: number): HistoryTail | undefined {
    if (limit === 0) return state.summary;
    if (!state.page || state.page.limit < limit) return;
    const result = JSON.parse(state.page.raw) as HistoryTail;
    return {
      messages: result.messages.slice(-limit),
      activeLeafId: result.activeLeafId,
      hasMore: result.hasMore || result.messages.length > limit,
    };
  }
  save(thread: string, state: State, limit: number, page: HistoryTail) {
    if (!this.valid(thread, state)) return;
    state.summary = { messages: [], activeLeafId: page.activeLeafId, hasMore: !!page.messages.length || page.hasMore };
    if (!limit) return;
    this.dropPage(state);
    const raw = JSON.stringify(page),
      bytes = Buffer.byteLength(raw);
    if (bytes > 512 * 1024) return;
    state.page = { raw, bytes, limit: page.hasMore ? limit : Infinity };
    this.retained += bytes;
    if (this.retained > 24 * 1024 * 1024)
      for (const known of this.states.values()) {
        this.dropPage(known);
        if (this.retained <= 20 * 1024 * 1024) break;
      }
  }
}
export const overviewHistory = new HistorySnapshotCache();
