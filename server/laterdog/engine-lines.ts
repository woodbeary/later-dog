import type { Readable } from "node:stream";

export function consumeEngineLines(
  input: Readable,
  receive: (line: string) => void,
  finishPartial = false,
  cooperative = process.env.LATERDOG_HISTORY_MODE === "remote",
): (closed: () => void) => void {
  let buffer = "",
    draining = false,
    ended = false;
  const listeners: Array<() => void> = [];
  function drain() {
    draining = true;
    const start = performance.now();
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) receive(line);
      end = buffer.indexOf("\n");
      if (cooperative && performance.now() - start >= 8) {
        input.pause();
        setImmediate(drain);
        return;
      }
    }
    if (ended && finishPartial && buffer.trim()) {
      const remainder = buffer;
      buffer = "";
      receive(remainder);
    }
    draining = false;
    if (!ended && cooperative && input.isPaused()) input.resume();
    if (ended) for (const listener of listeners.splice(0)) listener();
  }
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    if (!draining) drain();
  });
  function end() {
    ended = true;
    if (!draining) drain();
  }
  input.once("end", end);
  input.once("close", end);
  return (closed) => {
    if (!cooperative || (ended && !draining)) closed();
    else listeners.push(closed);
  };
}
