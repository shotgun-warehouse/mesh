import type {
  DeviceDetail,
  ItemTrace,
  LinkDetail,
  RunSummary,
  Snapshot,
} from "./engine/engine";
import type { ActionBody, RunFile } from "./engine/types";

export type InspectTarget =
  | { kind: "device"; id: string }
  | { kind: "link"; a: string; b: string }
  | null;

/** UI → worker. The UI drives time (`advanceTo`), so two workers in Compare mode stay in lockstep. */
export type WorkerCommand =
  | { type: "init"; run: RunFile }
  | { type: "advanceTo"; t: number }
  | { type: "step"; mode: "event" | "100ms" }
  | { type: "runUntilConverged"; maxMs: number }
  | { type: "stop" }
  | { type: "action"; action: ActionBody }
  | { type: "inspect"; target: InspectTarget }
  | { type: "trace"; tid: string | null }
  | { type: "export"; requestId: number };

export type Detail =
  | { kind: "device"; detail: DeviceDetail }
  | { kind: "link"; detail: LinkDetail }
  | null;

/** Worker → UI. */
export type WorkerMessage =
  | {
      type: "snapshot";
      snapshot: Snapshot;
      detail: Detail | undefined;
      trace: ItemTrace | null | undefined;
      summary: RunSummary;
      /** True while a `runUntilConverged` loop is going. */
      converging: boolean;
      /** The command that produced this snapshot finished (the UI may send the next advance). */
      idle: boolean;
    }
  | { type: "export"; requestId: number; run: RunFile }
  | { type: "error"; message: string };
