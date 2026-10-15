import type { ItemTrace, RunSummary, Snapshot } from "../engine/engine";
import type { MetricSample } from "../engine/metrics";
import type { ActionBody, LogLine, RunFile } from "../engine/types";
import type {
  Detail,
  InspectTarget,
  WorkerCommand,
  WorkerMessage,
} from "../protocol";

const MAX_LOG_LINES = 4_000;

export type ClientState = {
  snapshot: Snapshot | null;
  samples: MetricSample[];
  log: LogLine[];
  detail: Detail;
  trace: ItemTrace | null;
  summary: RunSummary | null;
  converging: boolean;
  error: string | null;
  /** Real time (performance.now) the snapshot arrived, to extrapolate packet motion. */
  receivedAt: number;
};

/** One simulation worker plus what the UI accumulated from it. */
export class SimClient {
  private readonly worker: Worker;
  private state: ClientState = {
    snapshot: null,
    samples: [],
    log: [],
    detail: null,
    trace: null,
    summary: null,
    converging: false,
    error: null,
    receivedAt: 0,
  };
  private readonly listeners = new Set<() => void>();
  private nextRequestId = 1;
  private readonly exports = new Map<number, (run: RunFile) => void>();
  /** No command in flight: the driver may send the next advance. */
  idle = false;

  constructor(readonly name: string) {
    this.worker = new Worker(new URL("../worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) =>
      this.receive(event.data);
  }

  getState = (): ClientState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  init(run: RunFile): void {
    this.state = {
      ...this.state,
      snapshot: null,
      samples: [],
      log: [],
      detail: null,
      trace: null,
      summary: null,
    };
    this.idle = false;
    this.send({ type: "init", run });
    this.emit();
  }

  advanceTo(t: number): void {
    this.idle = false;
    this.send({ type: "advanceTo", t });
  }

  step(mode: "event" | "100ms"): void {
    this.idle = false;
    this.send({ type: "step", mode });
  }

  runUntilConverged(maxMs: number): void {
    this.idle = false;
    this.send({ type: "runUntilConverged", maxMs });
  }

  stop(): void {
    this.send({ type: "stop" });
  }

  act(action: ActionBody): void {
    this.idle = false;
    this.send({ type: "action", action });
  }

  inspect(target: InspectTarget): void {
    this.send({ type: "inspect", target });
  }

  trace(tid: string | null): void {
    this.send({ type: "trace", tid });
  }

  exportRun(): Promise<RunFile> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.exports.set(requestId, resolve);
      this.send({ type: "export", requestId });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }

  private send(command: WorkerCommand): void {
    this.worker.postMessage(command);
  }

  private receive(message: WorkerMessage): void {
    if (message.type === "export") {
      this.exports.get(message.requestId)?.(message.run);
      this.exports.delete(message.requestId);
      return;
    }
    if (message.type === "error") {
      this.state = { ...this.state, error: message.message };
      this.idle = true;
      this.emit();
      return;
    }

    const { snapshot } = message;
    const log = this.state.log.concat(snapshot.log);
    this.state = {
      snapshot,
      samples:
        snapshot.samples.length > 0
          ? this.state.samples.concat(snapshot.samples)
          : this.state.samples,
      log: log.length > MAX_LOG_LINES ? log.slice(-MAX_LOG_LINES) : log,
      detail: message.detail === undefined ? this.state.detail : message.detail,
      trace: message.trace === undefined ? this.state.trace : message.trace,
      summary: message.summary,
      converging: message.converging,
      error: null,
      receivedAt: performance.now(),
    };
    if (message.idle) this.idle = true;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
