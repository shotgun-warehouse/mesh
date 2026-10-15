import type { MeshSyncOptions } from "@sync/sync";

import { buildPresetRun, type PresetName } from "./presets";
import type { Action, ActionBody, NetworkParams, RunFile } from "./types";

/** "250ms", "30s", "5m", "1h", or a number of milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  if (!match) throw new Error(`Invalid duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    unit as "ms" | "s" | "m" | "h"
  ];
  return amount * factor;
}

export function formatDuration(milliseconds: number): string {
  const totalMs = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

export type Expectation = {
  /** Maximum lost-by-protocol pairs at the end of the run. */
  lostByProtocol?: number;
  /** Converged at most this long after the last action ("30s"). */
  convergedWithin?: string;
  /** Minimum coverage across powered devices at the end. */
  coverageMin?: number;
};

export type ScenarioAction = ActionBody & { at: string | number };

/** A run file with expectations, as stored in `simulator/scenarios/*.json`. */
export type Scenario = {
  name: string;
  description?: string;
  seed: number;
  preset: PresetName;
  params?: Partial<NetworkParams>;
  actions: ScenarioAction[];
  runUntil: string;
  /**
   * Named sets of sync knobs to bench (`MeshProvider` `sync`); defaults to `DEFAULT_VARIANTS`:
   * the library defaults, and repair off (each item flooded once, Backstage's old outbox).
   */
  variants?: Record<string, MeshSyncOptions>;
  /** Expectations per variant name. */
  expect?: Record<string, Expectation>;
};

export const DEFAULT_VARIANTS: Record<string, MeshSyncOptions> = {
  default: {},
  "no-repair": { repair: false },
};

export function scenarioToRun(
  scenario: Scenario,
  sync: MeshSyncOptions = {},
): RunFile {
  const { config, actions: presetActions } = buildPresetRun(scenario.preset);
  Object.assign(config.params, scenario.params);
  config.sync = { ...sync };
  const actions: Action[] = [
    ...presetActions,
    ...scenario.actions.map(
      (action) => ({ ...action, at: parseDuration(action.at) }) as Action,
    ),
  ].sort((left, right) => left.at - right.at);
  return { seed: scenario.seed, config, actions };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function pipeThrough(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

/** Compact, URL-safe encoding of a run (deflate + base64url) for share links. */
export async function encodeRun(run: RunFile): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(run));
  return toBase64Url(
    await pipeThrough(json, new CompressionStream("deflate-raw")),
  );
}

export async function decodeRun(encoded: string): Promise<RunFile> {
  const json = await pipeThrough(
    fromBase64Url(encoded),
    new DecompressionStream("deflate-raw"),
  );
  return JSON.parse(new TextDecoder().decode(json)) as RunFile;
}
