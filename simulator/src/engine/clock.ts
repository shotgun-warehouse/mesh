/** Wall-clock time of virtual t = 0, so packet timestamps look like real ones. */
export const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * Microtask turns given to promise continuations after each timer fires. Router chains
 * (`await sendPacketAsync` → finally → flush → caller) settle in well under this many turns;
 * a longer chain simply finishes during the next timer's drain, which is still deterministic.
 */
const MICROTASK_DRAIN_TURNS = 48;
/**
 * Turns given before and after a user action, and when the engine hands control back. A live
 * action always follows such a drain, so a replayed action must too, or the two runs diverge.
 */
export const SETTLE_DRAIN_TURNS = 512;

type Timer = {
  id: number;
  at: number;
  seq: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  intervalMs: number | null;
};

type SavedGlobals = {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  dateNow: typeof Date.now;
  random: typeof Math.random;
};

export async function drainMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await undefined;
  }
}

function heapLess(left: Timer, right: Timer): boolean {
  return left.at < right.at || (left.at === right.at && left.seq < right.seq);
}

/**
 * Virtual time for one simulation. While the simulation runs (`enter` … `exit`), the global
 * `setTimeout`, `setInterval`, their `clear*` and `Date.now` point here and `Math.random` is the
 * run's seeded PRNG, so the unmodified router runs on virtual time with reproducible UUIDs. Timers fire in (time, creation) order; between timers, promise
 * continuations get a fixed number of microtask turns. No real timer is ever involved, so a run
 * is a pure function of its inputs, in Node and in the browser.
 *
 * Globals are swapped in only while the engine runs, which keeps the test runner's own timers
 * real and lets two simulations share a thread.
 */
export class VirtualClock {
  /** Virtual milliseconds since the start of the run. */
  now = 0;
  /** Timers fired so far: a precise position in the run, used to replay actions exactly. */
  fired = 0;
  private heap: Timer[] = [];
  private live = new Map<number, Timer>();
  private nextId = 1;
  private nextSeq = 0;
  private depth = 0;
  private saved: SavedGlobals | null = null;

  constructor(private readonly random: () => number) {}

  enter(): void {
    this.depth += 1;
    if (this.depth > 1) {
      return;
    }

    this.saved = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      dateNow: Date.now,
      random: Math.random,
    };
    const fakeGlobals = globalThis as unknown as Record<string, unknown>;
    fakeGlobals.setTimeout = (
      callback: (...args: unknown[]) => void,
      delayMs?: number,
      ...args: unknown[]
    ) => this.setTimeout(callback, delayMs, ...args);
    fakeGlobals.clearTimeout = (id?: number) => this.clearTimer(id);
    fakeGlobals.setInterval = (
      callback: (...args: unknown[]) => void,
      delayMs?: number,
      ...args: unknown[]
    ) => this.setInterval(callback, delayMs, ...args);
    fakeGlobals.clearInterval = (id?: number) => this.clearTimer(id);
    Date.now = () => VIRTUAL_EPOCH_MS + Math.floor(this.now);
    Math.random = this.random;
  }

  exit(): void {
    this.depth -= 1;
    if (this.depth > 0 || !this.saved) {
      return;
    }

    globalThis.setTimeout = this.saved.setTimeout;
    globalThis.clearTimeout = this.saved.clearTimeout;
    globalThis.setInterval = this.saved.setInterval;
    globalThis.clearInterval = this.saved.clearInterval;
    Date.now = this.saved.dateNow;
    Math.random = this.saved.random;
    this.saved = null;
  }

  /** Runs `task` on virtual time and lets its promise chains settle before restoring globals. */
  async run<T>(task: () => T | Promise<T>): Promise<T> {
    this.enter();
    try {
      const result = await task();
      await drainMicrotasks(SETTLE_DRAIN_TURNS);
      return result;
    } finally {
      this.exit();
    }
  }

  setTimeout(
    callback: (...args: unknown[]) => void,
    delayMs = 0,
    ...args: unknown[]
  ): number {
    return this.schedule(callback, delayMs, args, null);
  }

  setInterval(
    callback: (...args: unknown[]) => void,
    delayMs = 0,
    ...args: unknown[]
  ): number {
    return this.schedule(callback, delayMs, args, Math.max(1, delayMs));
  }

  clearTimer(id: number | undefined): void {
    if (id !== undefined) {
      this.live.delete(id);
    }
  }

  /** Virtual time of the next pending timer, or null when none is left. */
  nextTimerAt(): number | null {
    this.dropCancelledHead();
    return this.heap[0]?.at ?? null;
  }

  pendingTimerCount(): number {
    return this.live.size;
  }

  /** Moves time forward without firing anything; never past a pending timer. */
  setNow(time: number): void {
    const nextAt = this.nextTimerAt();
    const target = nextAt === null ? time : Math.min(time, nextAt);
    this.now = Math.max(this.now, target);
  }

  /** Fires the next timer and lets its continuations run. False when nothing is scheduled. */
  async fireNext(): Promise<boolean> {
    this.dropCancelledHead();
    const timer = this.popHeap();
    if (!timer) {
      return false;
    }

    this.now = Math.max(this.now, timer.at);
    this.fired += 1;
    if (timer.intervalMs !== null) {
      timer.at = this.now + timer.intervalMs;
      timer.seq = this.nextSeq++;
      this.pushHeap(timer);
    } else {
      this.live.delete(timer.id);
    }

    timer.callback(...timer.args);
    await drainMicrotasks(MICROTASK_DRAIN_TURNS);
    return true;
  }

  private schedule(
    callback: (...args: unknown[]) => void,
    delayMs: number,
    args: unknown[],
    intervalMs: number | null,
  ): number {
    const safeDelay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    const timer: Timer = {
      id: this.nextId++,
      at: this.now + safeDelay,
      seq: this.nextSeq++,
      callback,
      args,
      intervalMs,
    };
    this.live.set(timer.id, timer);
    this.pushHeap(timer);
    return timer.id;
  }

  private dropCancelledHead(): void {
    while (this.heap.length > 0) {
      const head = this.heap[0]!;
      if (this.live.get(head.id) === head) {
        return;
      }
      this.popHeap();
    }
  }

  private pushHeap(timer: Timer): void {
    const heap = this.heap;
    heap.push(timer);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!heapLess(heap[index]!, heap[parent]!)) {
        break;
      }
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  }

  private popHeap(): Timer | undefined {
    const heap = this.heap;
    if (heap.length === 0) {
      return undefined;
    }
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heapLess(heap[left]!, heap[smallest]!)) {
          smallest = left;
        }
        if (right < heap.length && heapLess(heap[right]!, heap[smallest]!)) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
        index = smallest;
      }
    }
    return top;
  }
}
