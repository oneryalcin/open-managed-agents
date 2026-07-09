export interface WakeLoop {
  wake(): void;
  close(): Promise<void>;
}

export function createWakeLoop(opts: {
  nextWakeAt(): Date | null | Promise<Date | null>;
  run(): void | Promise<void>;
  maxSleepMs: number;
  minSleepMs: number;
  onError(error: unknown): void;
  now?: () => number;
}): WakeLoop {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let closed = false;

  const schedule = (delayMs: number) => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void cycle();
    }, delayMs);
  };

  const cycle = async () => {
    if (closed || running !== undefined) return;
    const work = (async () => {
      try {
        const dueAt = await opts.nextWakeAt();
        if (closed) return;
        if (dueAt !== null && dueAt.getTime() <= now()) {
          await opts.run();
          if (closed) return;
          schedule(opts.minSleepMs);
          return;
        }
        const untilDue = dueAt === null ? opts.maxSleepMs : dueAt.getTime() - now();
        schedule(Math.min(opts.maxSleepMs, Math.max(opts.minSleepMs, untilDue)));
      } catch (error) {
        opts.onError(error);
        schedule(opts.minSleepMs);
      }
    })();
    running = work;
    try {
      await work;
    } finally {
      running = undefined;
    }
  };

  schedule(0);
  return {
    wake() {
      if (closed || running !== undefined) return;
      schedule(0);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await running;
    },
  };
}
