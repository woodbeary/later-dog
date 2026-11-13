import {
  HELD_THREAD_READ_TIMEOUT_MS,
  HOME_QUEUES_PATH,
  homeQueuesAnswer,
  readThreadBack,
  threadPageAnswer,
  type FetchThread,
  type HomeQueues,
  type ThreadRead,
} from "./held-thread-check";

export const HELD_READS_AT_ONCE = 4;
export const HELD_READ_ROUND_MS = 20_000;

export interface HeldReadRound {
  queues(): Promise<HomeQueues | "unreadable">;
  thread(threadId: string, since: number | undefined, wanted: ReadonlySet<string>): Promise<ThreadRead>;
  close(): void;
}

export function heldReadRound(fetchThread: FetchThread, after: (ms: number, run: () => void) => () => void): HeldReadRound {
  const stop = new AbortController();
  let expired: Promise<"unreadable"> | null = null;
  let cancelExpiry = () => {};
  const expiry = () =>
    (expired ??= new Promise((resolve) => {
      cancelExpiry = after(HELD_READ_ROUND_MS, () => {
        stop.abort();
        resolve("unreadable");
      });
    }));
  let running = 0;
  const waiting: Array<() => void> = [];
  const slot = async () => {
    if (running < HELD_READS_AT_ONCE) running += 1;
    else await new Promise<void>((start) => waiting.push(start));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  const limited = <T>(path: string, answer: (response: Response) => Promise<T | "unreadable">): Promise<T | "unreadable"> => {
    const run = (async (): Promise<T | "unreadable"> => {
      await slot();
      try {
        if (stop.signal.aborted) return "unreadable";
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(HELD_THREAD_READ_TIMEOUT_MS)]);
        return await answer(await fetchThread(path, { headers: { "content-type": "application/json" }, signal }));
      } catch {
        return "unreadable";
      } finally {
        release();
      }
    })();
    return Promise.race([run, expiry()]);
  };
  let queues: Promise<HomeQueues | "unreadable"> | null = null;
  const threads = new Map<string, Promise<ThreadRead>>();
  return {
    queues: () => (queues ??= limited(HOME_QUEUES_PATH, homeQueuesAnswer)),
    thread(threadId, since, wanted) {
      let read = threads.get(threadId);
      if (!read) {
        read = readThreadBack((path) => limited(path, threadPageAnswer), threadId, since, wanted);
        threads.set(threadId, read);
      }
      return read;
    },
    close() {
      cancelExpiry();
      stop.abort();
    },
  };
}
