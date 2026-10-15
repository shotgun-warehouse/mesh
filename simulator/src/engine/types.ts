import type { MeshSyncOptions } from "@sync/sync";

export type Point = { x: number; y: number };

export type DevicePlatform = "ios" | "android";

/**
 * - `on`: Bluetooth on, app running, router started.
 * - `bluetoothOff`: router stopped, links dropped, memory and store kept. Scans still happen
 *   (staff keep scanning offline).
 * - `appKilled`: router destroyed; in-memory state is lost, the replica store survives.
 */
export type PowerState = "on" | "bluetoothOff" | "appKilled";

export type DeviceSpec = {
  /** Stable key used by actions and scenarios ("gate-6"). Survives factory resets. */
  id: string;
  label: string;
  position: Point;
  platform: DevicePlatform;
  power?: PowerState;
  /** Offset applied to this device's item timestamps (for HLC experiments). */
  clockSkewMs?: number;
  /** Overrides the platform default from `NetworkParams.maxLinks`. */
  maxLinks?: number;
  /** The device's `syncScope`; defaults to `SIM_SYNC_SCOPE`. `null` turns its sync off. */
  syncScope?: string | null;
};

export type Wall = { id: string; a: Point; b: Point };

export type NetworkParams = {
  /** Meters within which two devices discover each other. */
  range: number;
  writeLatencyMs: number;
  jitterMs: number;
  /** Probability in [0, 1] that one ATT write fails. */
  writeLoss: number;
  /** Mean time between random link drops; null means links never drop on their own. */
  linkMtbfMs: number | null;
  discoveryDelayMs: [number, number];
  connectDelayMs: [number, number];
  maxLinks: Record<DevicePlatform, number>;
  /** Bluetooth off/on toggles per device per hour. */
  bluetoothTogglesPerHour: number;
  /** App kills (and relaunches) per device per hour. */
  appKillsPerHour: number;
  /** Auto scans per device per minute; 0 stops the generator. */
  scanRatePerMin: number;
  /** Distinct tickets the generator draws from. */
  ticketPool: number;
  /** Size of one scan's data, like a Backstage sync action (over ~440 B it travels in parts). */
  itemBytes: number;
};

export const DEFAULT_PARAMS: NetworkParams = {
  range: 15,
  writeLatencyMs: 15,
  jitterMs: 5,
  writeLoss: 0.01,
  linkMtbfMs: 10 * 60_000,
  discoveryDelayMs: [500, 2_000],
  connectDelayMs: [300, 1_000],
  maxLinks: { ios: 7, android: 5 },
  bluetoothTogglesPerHour: 0,
  appKillsPerHour: 0,
  scanRatePerMin: 6,
  ticketPool: 500,
  itemBytes: 500,
};

export type RunConfig = {
  preset: string | null;
  /** The library's sync knobs (`MeshProvider` `sync`); omitted fields take the defaults. */
  sync: MeshSyncOptions;
  params: NetworkParams;
  devices: DeviceSpec[];
  walls: Wall[];
};

export type ActionBody =
  | { do: "addDevice"; device: DeviceSpec }
  | { do: "removeDevice"; device: string }
  | { do: "moveDevice"; device: string; position: Point }
  | { do: "setPower"; device: string; power: PowerState }
  | { do: "powerOff"; device: string }
  | { do: "powerOn"; device: string }
  | { do: "killApp"; device: string }
  | { do: "factoryReset"; device: string }
  | { do: "blockLink"; a: string; b: string }
  | { do: "unblockLink"; a: string; b: string }
  | { do: "pinLink"; a: string; b: string }
  | { do: "unpinLink"; a: string; b: string }
  | { do: "addWall"; wall: Wall }
  | { do: "removeWall"; id: string }
  | { do: "setParams"; params: Partial<NetworkParams> }
  | { do: "setSync"; sync: MeshSyncOptions }
  | { do: "setScope"; device: string; scope: string | null }
  | { do: "scan"; device: string }
  | { do: "burst"; device: string; count: number };

/**
 * A recorded user action. `at` is virtual ms; `event` (the number of timers fired before it)
 * pins it exactly, so a live action replays at the same point even mid-millisecond.
 */
export type Action = ActionBody & { at: number; event?: number };

export type RunFile = {
  seed: number;
  config: RunConfig;
  actions: Action[];
};

/** `item`: item parts (push or repair answer); `sync`: digests, vectors and requests. */
export type PacketKind = "identity" | "item" | "sync";

export type ItemAction = "scan" | "checkout";

/**
 * One scan, as the simulated app sees it (Backstage's sync action). It travels as the `data` of a
 * library item; `tid` identifies it in the app, like Backstage's `uuid`.
 */
export type Item = {
  tid: string;
  /** Mesh ID of the device that created it. */
  author: string;
  ticketId: number;
  action: ItemAction;
  createdAt: number;
  /** The ticket's latest item in the author's view when it decided; concurrency marker. */
  prev: string | null;
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogLine = {
  seq: number;
  t: number;
  device: string | null;
  /** Engine events (links, items, actions) or the router's own log lines. */
  source: "engine" | "router";
  tag: string;
  level: LogLevel;
  message: string;
  detail?: string;
};
