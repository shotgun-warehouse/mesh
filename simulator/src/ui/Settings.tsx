import { DEFAULT_SYNC_OPTIONS, type MeshSyncOptions } from "@sync/sync";

import type { NetworkParams } from "../engine/types";

type NumberField = {
  key: keyof NetworkParams;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Value shown and edited, from the stored value. */
  toView?: (value: number) => number;
  fromView?: (value: number) => number;
  unit: string;
};

const FIELDS: NumberField[] = [
  { key: "range", label: "Range", min: 2, max: 60, step: 1, unit: "m" },
  {
    key: "writeLatencyMs",
    label: "Write latency",
    min: 1,
    max: 200,
    step: 1,
    unit: "ms",
  },
  { key: "jitterMs", label: "Jitter", min: 0, max: 100, step: 1, unit: "ms" },
  {
    key: "writeLoss",
    label: "Write loss",
    min: 0,
    max: 50,
    step: 0.5,
    unit: "%",
    toView: (value) => value * 100,
    fromView: (value) => value / 100,
  },
  {
    key: "bluetoothTogglesPerHour",
    label: "Bluetooth toggles",
    min: 0,
    max: 60,
    step: 1,
    unit: "/device/h",
  },
  {
    key: "appKillsPerHour",
    label: "App kills",
    min: 0,
    max: 60,
    step: 1,
    unit: "/device/h",
  },
  {
    key: "scanRatePerMin",
    label: "Scan rate",
    min: 0,
    max: 60,
    step: 1,
    unit: "/device/min",
  },
  {
    key: "ticketPool",
    label: "Ticket pool",
    min: 10,
    max: 5000,
    step: 10,
    unit: "tickets",
  },
  {
    key: "itemBytes",
    label: "Scan size",
    min: 100,
    max: 4000,
    step: 50,
    unit: "B",
  },
];

const ROUTER_TOGGLES = [
  {
    label: "Relay jitter + suppression",
    detail: "Cancel a relay when heard from k neighbours.",
  },
  {
    label: "Time-bounded dedup cache",
    detail: "Instead of the last 500 packet IDs.",
  },
  {
    label: "Defer relays during fragment transfers",
    detail: "Instead of dropping them.",
  },
];

type Props = {
  params: NetworkParams;
  /** Sync knobs of run A, and of run B in Compare mode. */
  syncA: MeshSyncOptions;
  syncB: MeshSyncOptions | null;
  onSync: (target: "A" | "B", sync: MeshSyncOptions) => void;
  seed: number;
  onParams: (params: Partial<NetworkParams>) => void;
  onSeed: (seed: number) => void;
  onClose: () => void;
};

type SyncField = {
  key:
    | "minDigestIntervalMs"
    | "maxDigestIntervalMs"
    | "maxItemsPerRequest"
    | "pushHops";
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
};

const SYNC_FIELDS: SyncField[] = [
  {
    key: "pushHops",
    label: "Push hops",
    min: 0,
    max: 10,
    step: 1,
    unit: "hops",
  },
  {
    key: "minDigestIntervalMs",
    label: "Digest interval min",
    min: 200,
    max: 10_000,
    step: 100,
    unit: "ms",
  },
  {
    key: "maxDigestIntervalMs",
    label: "Digest interval max",
    min: 1_000,
    max: 120_000,
    step: 1_000,
    unit: "ms",
  },
  {
    key: "maxItemsPerRequest",
    label: "Items per request",
    min: 1,
    max: 200,
    step: 1,
    unit: "items",
  },
];

/** The library's sync knobs (`MeshProvider` `sync`), as a Backstage build would set them. */
function SyncKnobs({
  title,
  sync,
  onChange,
}: {
  title: string;
  sync: MeshSyncOptions;
  onChange: (sync: MeshSyncOptions) => void;
}) {
  const resolved = { ...DEFAULT_SYNC_OPTIONS, ...sync };
  return (
    <>
      <h3>{title}</h3>
      <label className="toggle">
        <input
          type="checkbox"
          checked={resolved.repair}
          onChange={(event) => onChange({ repair: event.target.checked })}
        />
        <span>
          Repair
          <br />
          <span className="muted">
            Off: each item is flooded once, nothing re-sends it.
          </span>
        </span>
      </label>
      {SYNC_FIELDS.map((field) => (
        <label key={field.key} className="field">
          <span>
            {field.label} <strong>{resolved[field.key]}</strong> {field.unit}
            {sync[field.key] === undefined && (
              <span className="muted"> (default)</span>
            )}
          </span>
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={resolved[field.key]}
            onChange={(event) =>
              onChange({ [field.key]: Number(event.target.value) })
            }
          />
        </label>
      ))}
    </>
  );
}

/** Network parameters. Changes apply live (as recorded `setParams` actions); the seed resets the run. */
export function Settings({
  params,
  syncA,
  syncB,
  onSync,
  seed,
  onParams,
  onSeed,
  onClose,
}: Props) {
  const mtbfSeconds =
    params.linkMtbfMs === null ? null : params.linkMtbfMs / 1000;
  return (
    <aside className="settings">
      <header className="panel-header">
        <h2>Settings</h2>
        <button onClick={onClose}>Close</button>
      </header>
      <p className="muted">Changes apply live and are recorded in the run.</p>

      {FIELDS.map((field) => {
        const stored = params[field.key] as number;
        const value = field.toView ? field.toView(stored) : stored;
        const commit = (next: number) =>
          onParams({
            [field.key]: field.fromView ? field.fromView(next) : next,
          });
        return (
          <label key={field.key} className="field">
            <span>
              {field.label}{" "}
              <strong>
                {Number.isInteger(value) ? value : value.toFixed(1)}
              </strong>{" "}
              {field.unit}
            </span>
            <input
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={value}
              onChange={(event) => commit(Number(event.target.value))}
            />
          </label>
        );
      })}

      <label className="field">
        <span>
          Link MTBF{" "}
          <strong>
            {mtbfSeconds === null
              ? "∞"
              : mtbfSeconds >= 60
                ? `${(mtbfSeconds / 60).toFixed(1)} min`
                : `${mtbfSeconds} s`}
          </strong>
        </span>
        <input
          type="range"
          min={5}
          max={3605}
          step={5}
          value={mtbfSeconds ?? 3605}
          onChange={(event) => {
            const next = Number(event.target.value);
            onParams({ linkMtbfMs: next >= 3605 ? null : next * 1000 });
          }}
        />
      </label>

      <label className="field">
        <span>
          Discovery delay{" "}
          <strong>
            {(params.discoveryDelayMs[0] / 1000).toFixed(1)}–
            {(params.discoveryDelayMs[1] / 1000).toFixed(1)}
          </strong>{" "}
          s
        </span>
        <input
          type="range"
          min={0}
          max={10}
          step={0.5}
          value={params.discoveryDelayMs[1] / 1000}
          onChange={(event) => {
            const max = Number(event.target.value) * 1000;
            onParams({
              discoveryDelayMs: [
                Math.min(params.discoveryDelayMs[0], max),
                max,
              ],
            });
          }}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>
            Max links iOS <strong>{params.maxLinks.ios}</strong>
          </span>
          <input
            type="range"
            min={1}
            max={20}
            value={params.maxLinks.ios}
            onChange={(event) =>
              onParams({
                maxLinks: {
                  ...params.maxLinks,
                  ios: Number(event.target.value),
                },
              })
            }
          />
        </label>
        <label className="field">
          <span>
            Android <strong>{params.maxLinks.android}</strong>
          </span>
          <input
            type="range"
            min={1}
            max={20}
            value={params.maxLinks.android}
            onChange={(event) =>
              onParams({
                maxLinks: {
                  ...params.maxLinks,
                  android: Number(event.target.value),
                },
              })
            }
          />
        </label>
      </div>

      <SyncKnobs
        title={syncB ? "Sync knobs · A" : "Sync knobs"}
        sync={syncA}
        onChange={(sync) => onSync("A", sync)}
      />
      {syncB && (
        <SyncKnobs
          title="Sync knobs · B"
          sync={syncB}
          onChange={(sync) => onSync("B", sync)}
        />
      )}

      <h3>Seed</h3>
      <div className="field-row">
        <input
          type="number"
          defaultValue={seed}
          key={seed}
          onKeyDown={(event) => {
            if (event.key === "Enter")
              onSeed(Number((event.target as HTMLInputElement).value) || 0);
          }}
        />
        <button onClick={() => onSeed(Math.floor(Math.random() * 1_000_000))}>
          Random
        </button>
      </div>
      <p className="muted">
        Changing the seed restarts the run (Enter to apply).
      </p>

      <h3>Router toggles</h3>
      {ROUTER_TOGGLES.map((toggle) => (
        <label
          key={toggle.label}
          className="toggle disabled"
          title="Needs a router change first"
        >
          <input type="checkbox" disabled />
          <span>
            {toggle.label}
            <br />
            <span className="muted">
              {toggle.detail} Needs a router change first.
            </span>
          </span>
        </label>
      ))}
    </aside>
  );
}
