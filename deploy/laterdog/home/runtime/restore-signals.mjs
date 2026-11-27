export const HELD_SIGNALS = ["SIGTERM", "SIGINT"];

export function holdStopsWhileRestoring({ log = () => {}, events = process, now = Date.now } = {}) {
  const received = [];
  const handler = (signal) => {
    received.push({ signal, at: now() });
    log(`${signal} arrived while restoring; nothing is saved during a restore, so the restore carries on and the home starts when it is done`);
  };
  for (const signal of HELD_SIGNALS) events.on(signal, handler);
  return {
    received,
    release() {
      for (const signal of HELD_SIGNALS) events.off(signal, handler);
      return received;
    },
  };
}
