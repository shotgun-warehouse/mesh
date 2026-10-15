/// <reference lib="webworker" />
import { Engine } from "./engine/engine";
import type {
  Detail,
  InspectTarget,
  WorkerCommand,
  WorkerMessage,
} from "./protocol";

/** Real timers, captured before any engine swaps the globals for virtual ones. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Real-time budget per slice of a "run until converged" loop before a snapshot goes out. */
const CONVERGE_SLICE_MS = 40;
/** Detail (inspector) payloads are heavier: send them with every Nth snapshot. */
const DETAIL_EVERY = 4;

let engine: Engine | null = null;
let sampleCursor = 0;
let logCursor = 0;
let inspectTarget: InspectTarget = null;
let traceTid: string | null = null;
let snapshotCount = 0;
let converging = false;
let stopRequested = false;
const queue: WorkerCommand[] = [];
let draining = false;

function post(message: WorkerMessage): void {
  scope.postMessage(message);
}

function readDetail(): Detail {
  if (!engine || !inspectTarget) return null;
  if (inspectTarget.kind === "device") {
    const detail = engine.deviceDetail(inspectTarget.id);
    return detail ? { kind: "device", detail } : null;
  }
  return {
    kind: "link",
    detail: engine.linkDetail(inspectTarget.a, inspectTarget.b),
  };
}

function postSnapshot(idle: boolean, forceDetail = false): void {
  if (!engine) return;
  const snapshot = engine.snapshot(sampleCursor, logCursor);
  sampleCursor = snapshot.sampleCursor;
  logCursor = snapshot.logCursor;
  snapshotCount += 1;
  const withDetail = forceDetail || snapshotCount % DETAIL_EVERY === 0;
  post({
    type: "snapshot",
    snapshot,
    detail: withDetail ? readDetail() : undefined,
    trace: withDetail
      ? traceTid
        ? engine.traceItem(traceTid)
        : null
      : undefined,
    summary: engine.summary(),
    converging,
    idle,
  });
}

function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

async function runUntilConverged(maxMs: number): Promise<void> {
  if (!engine) return;
  converging = true;
  stopRequested = false;
  const startedAt = engine.now();
  // Converged right now does not count: something has to happen first.
  const minimumEnd = startedAt + 2_000;
  try {
    while (!stopRequested && engine.now() - startedAt < maxMs) {
      const sliceStart = performance.now();
      while (performance.now() - sliceStart < CONVERGE_SLICE_MS) {
        await engine.advanceBy(250);
        if (engine.converged && engine.now() >= minimumEnd) {
          return;
        }
      }
      postSnapshot(false);
      await yieldToEvents();
    }
  } finally {
    converging = false;
  }
}

async function handle(command: WorkerCommand): Promise<void> {
  switch (command.type) {
    case "init":
      engine?.dispose();
      engine = await Engine.create(command.run, { routerLogLevel: "info" });
      sampleCursor = 0;
      logCursor = 0;
      postSnapshot(true, true);
      return;
    case "advanceTo":
      if (!engine) return;
      if (command.t > engine.now()) await engine.advanceTo(command.t);
      postSnapshot(true);
      return;
    case "step":
      if (!engine) return;
      if (command.mode === "event") await engine.step();
      else await engine.advanceBy(100);
      postSnapshot(true, true);
      return;
    case "runUntilConverged":
      await runUntilConverged(command.maxMs);
      postSnapshot(true, true);
      return;
    case "stop":
      return;
    case "action":
      if (!engine) return;
      await engine.applyLive(command.action);
      postSnapshot(true, true);
      return;
    case "inspect":
      inspectTarget = command.target;
      postSnapshot(true, true);
      return;
    case "trace":
      traceTid = command.tid;
      postSnapshot(true, true);
      return;
    case "export":
      if (engine)
        post({
          type: "export",
          requestId: command.requestId,
          run: engine.exportRun(),
        });
      return;
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const command = queue.shift()!;
      try {
        await handle(command);
      } catch (error) {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    draining = false;
  }
}

scope.onmessage = (event: MessageEvent<WorkerCommand>) => {
  // "stop" interrupts a running converge loop; everything else waits its turn.
  if (event.data.type === "stop") {
    stopRequested = true;
    return;
  }
  queue.push(event.data);
  void drain();
};
