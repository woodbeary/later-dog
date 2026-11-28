export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<() => void | Promise<void>>;
  exit: (code: number) => void;
  timeoutMs?: number;
}

export function createGracefulShutdown({
  cleanup,
  exit,
  timeoutMs = 6_000,
}: GracefulShutdownOptions) {
  let started = false;
  const stop = (verified: boolean, accepted?: () => void) => {
    if (started) return;
    started = true;
    accepted?.();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(cleanup.map((job) => Promise.resolve().then(job)))
      .then(results => results.every(result => result.status === "fulfilled"));

    void Promise.race([settled, deadline]).then(complete => {
      if (timer) clearTimeout(timer);
      exit(verified && !complete ? 1 : 0);
    });
  };
  return Object.assign(() => stop(false), { verified: (accepted?: () => void) => stop(true, accepted) });
}


export function listenForVerifiedShutdown(shutdown: ReturnType<typeof createGracefulShutdown>) {
  if (!process.send || process.env.LATERDOG_CLOUD_ROLE !== "home") return;
  process.on("message", message => {
    const request = message as { type?: string; id?: string } | null;
    if (request?.type !== "history.home.stop" || typeof request.id !== "string" || request.id.length !== 36) return;
    shutdown.verified(() => process.send?.({ type: "history.home.stopping", id: request.id }));
  });
  process.channel?.unref();
}
