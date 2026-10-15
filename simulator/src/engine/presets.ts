import {
  DEFAULT_PARAMS,
  type Action,
  type DevicePlatform,
  type DeviceSpec,
  type NetworkParams,
  type RunConfig,
  type Wall,
} from "./types";

export type PresetName =
  | "two-devices"
  | "perfect-lab"
  | "main-gate"
  | "two-halls"
  | "hostile"
  | "late-joiner";

export type Preset = {
  name: PresetName;
  title: string;
  description: string;
  build: () => {
    params: Partial<NetworkParams>;
    devices: DeviceSpec[];
    walls: Wall[];
    actions: Action[];
  };
};

function device(
  id: string,
  label: string,
  x: number,
  y: number,
  platform: DevicePlatform,
  extra: Partial<DeviceSpec> = {},
): DeviceSpec {
  return { id, label, position: { x, y }, platform, ...extra };
}

/** Alternates iOS and Android so both connection caps show up. */
function platformAt(index: number): DevicePlatform {
  return index % 3 === 2 ? "android" : "ios";
}

function grid(
  prefix: string,
  labelPrefix: string,
  count: number,
  columns: number,
  origin: { x: number; y: number },
  spacing: number,
  platformOf: (index: number) => DevicePlatform = platformAt,
): DeviceSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    // A small, fixed stagger so links do not all have the same length.
    const stagger = ((index * 37) % 10) / 10 - 0.5;
    return device(
      `${prefix}-${index + 1}`,
      `${labelPrefix} ${index + 1}`,
      origin.x + column * spacing + stagger,
      origin.y + row * spacing - stagger,
      platformOf(index),
    );
  });
}

function mainGateDevices(): DeviceSpec[] {
  return grid("gate", "Gate", 12, 4, { x: 40, y: 22 }, 3.5);
}

export const PRESETS: Preset[] = [
  {
    name: "two-devices",
    title: "Two devices",
    description:
      "The simplest mesh: two phones 8 m apart, one link, no loss. Watch one scan travel.",
    build: () => ({
      params: {
        writeLoss: 0,
        jitterMs: 0,
        linkMtbfMs: null,
        scanRatePerMin: 2,
      },
      devices: [
        device("phone-a", "Phone A", 46, 30, "ios"),
        device("phone-b", "Phone B", 54, 30, "android"),
      ],
      walls: [],
      actions: [],
    }),
  },
  {
    name: "perfect-lab",
    title: "Perfect lab",
    description: "8 devices on a bench: no loss, no churn.",
    build: () => ({
      params: {
        writeLoss: 0,
        jitterMs: 0,
        linkMtbfMs: null,
        bluetoothTogglesPerHour: 0,
        appKillsPerHour: 0,
      },
      devices: grid("lab", "Lab", 8, 4, { x: 38, y: 24 }, 6),
      walls: [],
      actions: [],
    }),
  },
  {
    name: "main-gate",
    title: "Main gate",
    description: "12 devices in a tight cluster, 3 % write loss.",
    build: () => ({
      params: { writeLoss: 0.03 },
      devices: mainGateDevices(),
      walls: [],
      actions: [],
    }),
  },
  {
    name: "two-halls",
    title: "Two halls",
    description: "Two clusters of six joined by one corridor device.",
    build: () => ({
      params: {},
      devices: [
        // Android phones (cap 5) sit far from the corridor: next to it they would spend every
        // slot on hall links and leave none for the bridge.
        ...grid("hall-a", "Hall A", 6, 3, { x: 24, y: 25 }, 5, (index) =>
          index % 3 === 0 ? "android" : "ios",
        ),
        device("corridor", "Corridor", 47, 28.5, "ios"),
        ...grid("hall-b", "Hall B", 6, 3, { x: 60, y: 25 }, 5, (index) =>
          index % 3 === 2 ? "android" : "ios",
        ),
      ],
      walls: [
        { id: "wall-a-top", a: { x: 41, y: 5 }, b: { x: 41, y: 23 } },
        { id: "wall-a-bottom", a: { x: 41, y: 35 }, b: { x: 41, y: 55 } },
        { id: "wall-b-top", a: { x: 53, y: 5 }, b: { x: 53, y: 23 } },
        { id: "wall-b-bottom", a: { x: 53, y: 35 }, b: { x: 53, y: 55 } },
      ],
      actions: [],
    }),
  },
  {
    name: "hostile",
    title: "Hostile",
    description:
      "25 % loss, links drop every 30 s on average, apps get killed.",
    build: () => ({
      params: {
        writeLoss: 0.25,
        linkMtbfMs: 30_000,
        appKillsPerHour: 6,
        bluetoothTogglesPerHour: 4,
      },
      devices: grid("dev", "Device", 15, 5, { x: 30, y: 18 }, 6),
      walls: [],
      actions: [],
    }),
  },
  {
    name: "late-joiner",
    title: "Late joiner",
    description: "Main gate, but one device turns Bluetooth on 5 minutes in.",
    build: () => ({
      params: { writeLoss: 0.03 },
      devices: [
        ...mainGateDevices(),
        device("late", "Late", 47, 36, "android", { power: "bluetoothOff" }),
      ],
      walls: [],
      actions: [{ at: 5 * 60_000, do: "powerOn", device: "late" }],
    }),
  },
];

export function findPreset(name: string): Preset {
  const preset = PRESETS.find((candidate) => candidate.name === name);
  if (!preset) {
    throw new Error(`Unknown preset "${name}"`);
  }
  return preset;
}

export function buildPresetRun(name: PresetName): {
  config: RunConfig;
  actions: Action[];
} {
  const built = findPreset(name).build();
  return {
    config: {
      preset: name,
      sync: {},
      params: { ...DEFAULT_PARAMS, ...built.params },
      devices: built.devices,
      walls: built.walls,
    },
    actions: built.actions,
  };
}
