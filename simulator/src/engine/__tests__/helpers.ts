import type { MeshSyncOptions } from "@sync/sync";

import { Engine } from "../engine";
import {
  DEFAULT_PARAMS,
  type DeviceSpec,
  type NetworkParams,
  type RunFile,
} from "../types";

export function lineDevices(count: number, spacing: number): DeviceSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index + 1}`,
    label: `D${index + 1}`,
    position: { x: 10 + index * spacing, y: 10 },
    platform: "ios" as const,
  }));
}

export function makeRun(
  devices: DeviceSpec[],
  params: Partial<NetworkParams> = {},
  sync: MeshSyncOptions = {},
  seed = 7,
): RunFile {
  return {
    seed,
    config: {
      preset: null,
      sync,
      params: { ...DEFAULT_PARAMS, scanRatePerMin: 0, ...params },
      devices,
      walls: [],
    },
    actions: [],
  };
}

/**
 * Starts `task` on the engine's virtual time without waiting for it: its timers only fire as the
 * engine advances. Wrapped in an object so `await` does not flatten (and block on) the promise.
 */
export async function begin<T>(
  engine: Engine,
  task: () => Promise<T>,
): Promise<{ result: Promise<T> }> {
  let started!: Promise<T>;
  await engine.clock.run(() => {
    started = task();
    started.catch(() => undefined);
  });
  return { result: started };
}
