import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { PRESETS, buildPresetRun, type PresetName } from "../engine/presets";
import { decodeRun, encodeRun } from "../engine/run";
import type { MeshSyncOptions } from "@sync/sync";

import type {
  ActionBody,
  NetworkParams,
  Point,
  RunFile,
} from "../engine/types";
import type { InspectTarget } from "../protocol";
import { Charts, type ChartRun } from "./Charts";
import { EventLog } from "./EventLog";
import { formatMs, formatPercent, formatTime } from "./format";
import { Inspector } from "./Inspector";
import {
  MapCanvas,
  type ContextTarget,
  type Selection,
  type Tool,
} from "./MapCanvas";
import { Settings } from "./Settings";
import { SimClient, type ClientState } from "./simClient";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
/** Real milliseconds between advance requests (≈ 30 snapshots per second). */
const FRAME_MS = 33;
/** "Run until converged" gives up after this much virtual time. */
const CONVERGE_LIMIT_MS = 30 * 60_000;

type ContextMenu = { target: ContextTarget; x: number; y: number } | null;

function useClient(client: SimClient | null): ClientState | null {
  const subscribe = useCallback(
    (listener: () => void) => (client ? client.subscribe(listener) : () => {}),
    [client],
  );
  const getState = useCallback(
    () => (client ? client.getState() : null),
    [client],
  );
  return useSyncExternalStore(subscribe, getState);
}

function withSync(run: RunFile, sync: MeshSyncOptions): RunFile {
  return { ...run, config: { ...run.config, sync: { ...sync } } };
}

/** Starting points for Compare mode's run B (its knobs stay editable in Settings). */
const COMPARE_PRESETS: { id: string; label: string; sync: MeshSyncOptions }[] =
  [
    { id: "no-repair", label: "vs repair off", sync: { repair: false } },
    {
      id: "push-0",
      label: "vs push to neighbours only",
      sync: { pushHops: 0 },
    },
    { id: "same", label: "vs same knobs (edit B)", sync: {} },
  ];

/** Short description of sync knobs that differ from the library defaults. */
export function describeSync(sync: MeshSyncOptions | undefined): string {
  const entries = Object.entries(sync ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return "library defaults";
  return entries.map(([key, value]) => `${key} ${String(value)}`).join(", ");
}

function initialRun(): RunFile {
  const { config, actions } = buildPresetRun("two-devices");
  return { seed: 42, config, actions };
}

export function App() {
  const [run, setRun] = useState<RunFile>(initialRun);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Selection>(null);
  const [traceTid, setTraceTid] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [clientA] = useState(() => new SimClient("A"));
  const [clientB, setClientB] = useState<SimClient | null>(null);
  const stateA = useClient(clientA);
  const stateB = useClient(clientB);
  const clients = useMemo(
    () => [clientA, ...(clientB ? [clientB] : [])],
    [clientA, clientB],
  );

  // Load a shared run from the URL once.
  useEffect(() => {
    const match = /run=([^&]+)/.exec(window.location.hash);
    if (!match) return;
    decodeRun(match[1]!)
      .then((decoded) => setRun(decoded))
      .catch(() => setNotice("Could not read the run in the URL."));
  }, []);

  // (Re)start the simulation(s) whenever the run or the compare choice changes. The compare
  // client lives in a ref too, so StrictMode's double effect run never creates two workers.
  const clientBRef = useRef<SimClient | null>(null);
  useEffect(() => {
    clientA.init(run);
    const comparePreset = COMPARE_PRESETS.find(
      (entry) => entry.id === compareId,
    );
    if (comparePreset) {
      clientBRef.current ??= new SimClient("B");
      clientBRef.current.init(
        withSync(run, { ...run.config.sync, ...comparePreset.sync }),
      );
    } else if (clientBRef.current) {
      clientBRef.current.terminate();
      clientBRef.current = null;
    }
    setClientB(clientBRef.current);
    setSelection(null);
    setTraceTid(null);
  }, [run, compareId, clientA]);

  // Drive virtual time from the UI, so both runs in Compare mode see the same timeline.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      if (!playingRef.current) {
        last = now;
        return;
      }
      if (now - last < FRAME_MS) return;
      const ready = clients.every(
        (client) =>
          client.idle &&
          client.getState().snapshot &&
          !client.getState().converging,
      );
      if (!ready) return;
      const elapsed = Math.min(100, now - last);
      last = now;
      const current = Math.max(
        ...clients.map((client) => client.getState().snapshot!.t),
      );
      const target = current + elapsed * speedRef.current;
      for (const client of clients) client.advanceTo(target);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clients]);

  // Inspector target and trace follow the selection.
  useEffect(() => {
    const target: InspectTarget =
      selection?.kind === "device"
        ? { kind: "device", id: selection.id }
        : selection?.kind === "link"
          ? { kind: "link", a: selection.a, b: selection.b }
          : null;
    for (const client of clients) client.inspect(target);
  }, [selection, clients]);

  useEffect(() => {
    for (const client of clients) client.trace(traceTid);
  }, [traceTid, clients]);

  const act = useCallback(
    (action: ActionBody) => {
      for (const client of clients) client.act(action);
    },
    [clients],
  );

  // Slider drags would record one action per pixel: coalesce parameter changes.
  const pendingParams = useRef<Partial<NetworkParams>>({});
  const paramsTimer = useRef<number | null>(null);
  const changeParams = useCallback(
    (params: Partial<NetworkParams>) => {
      pendingParams.current = { ...pendingParams.current, ...params };
      if (paramsTimer.current !== null)
        window.clearTimeout(paramsTimer.current);
      paramsTimer.current = window.setTimeout(() => {
        act({ do: "setParams", params: pendingParams.current });
        pendingParams.current = {};
        paramsTimer.current = null;
      }, 150);
    },
    [act],
  );

  const snapshot = stateA?.snapshot ?? null;

  const addDevice = useCallback(
    (position: Point) => {
      const existing = new Set(snapshot?.devices.map((device) => device.id));
      let index = (snapshot?.devices.length ?? 0) + 1;
      while (existing.has(`dev-${index}`)) index += 1;
      act({
        do: "addDevice",
        device: {
          id: `dev-${index}`,
          label: `Device ${index}`,
          position: {
            x: Math.round(position.x * 10) / 10,
            y: Math.round(position.y * 10) / 10,
          },
          platform: index % 3 === 0 ? "android" : "ios",
        },
      });
    },
    [act, snapshot],
  );

  const deleteSelection = useCallback(() => {
    if (selection?.kind === "device")
      act({ do: "removeDevice", device: selection.id });
    if (selection?.kind === "wall") act({ do: "removeWall", id: selection.id });
    if (selection?.kind === "link")
      act({ do: "blockLink", a: selection.a, b: selection.b });
    setSelection(null);
  }, [act, selection]);

  const stepOnce = (mode: "event" | "100ms") => {
    setPlaying(false);
    for (const client of clients) client.step(mode);
  };

  const runUntilConverged = () => {
    setPlaying(false);
    for (const client of clients) client.runUntilConverged(CONVERGE_LIMIT_MS);
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA"
      )
        return;
      if (event.metaKey || event.ctrlKey) return;
      switch (event.key) {
        case "v":
          setTool("select");
          break;
        case "a":
          setTool("add");
          break;
        case "x":
          setTool("cut");
          break;
        case "w":
          setTool("wall");
          break;
        case "s":
          if (selection?.kind === "device")
            act({ do: "scan", device: selection.id });
          break;
        case "Backspace":
        case "Delete":
          deleteSelection();
          break;
        case " ":
          event.preventDefault();
          setPlaying((value) => !value);
          break;
        case "Escape":
          setContextMenu(null);
          setTool("select");
          setTraceTid(null);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, deleteSelection, selection]);

  const exportJson = async () => {
    const exported = await clientA.exportRun();
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mesh-run-${exported.seed}-${exported.config.preset ?? "custom"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const share = async () => {
    const exported = await clientA.exportRun();
    const encoded = await encodeRun(exported);
    const url = `${window.location.origin}${window.location.pathname}#run=${encoded}`;
    window.history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Share link copied: it replays this run, actions included.");
    } catch {
      setNotice("Share link is in the address bar.");
    }
  };

  const importJson = async (file: File) => {
    try {
      const imported = JSON.parse(await file.text()) as RunFile;
      setPlaying(false);
      setRun(imported);
    } catch {
      setNotice("That file is not a run export.");
    }
  };

  const replay = async () => {
    const exported = await clientA.exportRun();
    setPlaying(false);
    setRun(exported);
  };

  const reset = () => {
    setPlaying(false);
    setRun({
      ...run,
      actions: run.config.preset
        ? buildPresetRun(run.config.preset as PresetName).actions
        : [],
    });
  };

  const choosePreset = (preset: PresetName) => {
    const { config, actions } = buildPresetRun(preset);
    setPlaying(false);
    setRun({
      seed: run.seed,
      config: { ...config, sync: run.config.sync },
      actions,
    });
  };

  /** Sync knobs apply live, as recorded actions, to run A or run B only. */
  const changeSync = (target: "A" | "B", sync: MeshSyncOptions) => {
    const client = target === "A" ? clientA : clientB;
    client?.act({ do: "setSync", sync });
  };

  const chartRuns: ChartRun[] = [
    { name: "A", samples: stateA?.samples ?? [] },
    ...(stateB ? [{ name: "B", samples: stateB.samples }] : []),
  ];

  const converging = stateA?.converging || stateB?.converging;
  const latest = snapshot?.latest;

  // A new layout or a new split gets a fresh, fitted view.
  const mapKey = `${run.config.preset}-${run.seed}-${stateB ? "compare" : "single"}`;

  const mapProps = {
    playing,
    speed,
    tool,
    selection,
    onSelect: (next: Selection) => {
      setSelection(next);
      setContextMenu(null);
    },
    onAction: act,
    onAddDevice: addDevice,
    onContextMenu: (target: ContextTarget, x: number, y: number) =>
      setContextMenu({ target, x, y }),
  };

  return (
    <div className={`app ${settingsOpen ? "with-settings" : ""}`}>
      <header className="toolbar">
        <div className="group">
          <button
            className="primary"
            onClick={() => setPlaying((value) => !value)}
            title="Play / pause (Space)"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button onClick={() => stepOnce("event")} title="Step one event">
            ⏭
          </button>
          <button onClick={() => stepOnce("100ms")} title="Step 100 ms">
            +100ms
          </button>
          <select
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            title="Speed"
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          {converging ? (
            <button onClick={() => clients.forEach((client) => client.stop())}>
              Stop
            </button>
          ) : (
            <button
              onClick={runUntilConverged}
              title="As fast as possible until every connected device has every item"
            >
              Run until converged
            </button>
          )}
        </div>
        <div className="group clock mono">
          t={formatTime(snapshot?.t ?? 0)}
          <span className="muted"> seed {run.seed}</span>
        </div>
        <div className="group">
          <select
            value={run.config.preset ?? ""}
            onChange={(event) => choosePreset(event.target.value as PresetName)}
            title="Preset"
          >
            {!run.config.preset && <option value="">Custom</option>}
            {PRESETS.map((preset) => (
              <option
                key={preset.name}
                value={preset.name}
                title={preset.description}
              >
                {preset.title}
              </option>
            ))}
          </select>
          <select
            value={compareId ?? ""}
            onChange={(event) => setCompareId(event.target.value || null)}
            title="Compare mode: same seed, same actions, other sync knobs"
          >
            <option value="">Compare: off</option>
            {COMPARE_PRESETS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="group tools">
          {(
            [
              ["select", "V", "Select / drag"],
              ["add", "A", "Add device"],
              ["cut", "X", "Cut link"],
              ["wall", "W", "Draw wall"],
            ] as [Tool, string, string][]
          ).map(([value, key, label]) => (
            <button
              key={value}
              className={tool === value ? "active" : undefined}
              onClick={() => setTool(value)}
              title={`${label} (${key})`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="group">
          <button
            onClick={reset}
            title="Restart this preset and seed without your actions"
          >
            Reset
          </button>
          <button
            onClick={replay}
            title="Restart and replay every action so far"
          >
            Replay
          </button>
          <button onClick={exportJson}>Export</button>
          <label className="button">
            Import
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(event) =>
                event.target.files?.[0] && importJson(event.target.files[0])
              }
            />
          </label>
          <button onClick={share}>Share</button>
          <button
            className={settingsOpen ? "active" : undefined}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      <div className="summary">
        <span className={`pill ${snapshot?.converged ? "good" : "bad"}`}>
          {snapshot?.converged ? "converged" : "not converged"}
        </span>
        <span>
          items <strong>{latest?.items ?? 0}</strong>
        </span>
        <span>
          coverage <strong>{formatPercent(latest?.coverageMean ?? 0)}</strong>{" "}
          mean · <strong>{formatPercent(latest?.coverageMin ?? 0)}</strong> min
        </span>
        <span>
          lost by protocol{" "}
          <strong className={latest?.lostByProtocol ? "bad-text" : undefined}>
            {latest?.lostByProtocol ?? 0}
          </strong>
        </span>
        <span>
          propagation <strong>{formatMs(latest?.p50)}</strong> p50 ·{" "}
          <strong>{formatMs(latest?.p95)}</strong> p95
        </span>
        <span>
          <strong>{(latest?.writesPerSec ?? 0).toFixed(0)}</strong> writes/s ·{" "}
          <strong>{(latest?.writesPerItem ?? 0).toFixed(0)}</strong> per item
        </span>
        <span>
          conflicts <strong>{latest?.conflicts ?? 0}</strong>
        </span>
        {(snapshot?.oversizePackets ?? 0) > 0 && (
          <span className="pill bad">
            {snapshot!.oversizePackets} oversize packets
          </span>
        )}
        {stateB?.summary && (
          <span className="compare-summary">
            B ({describeSync(stateB.snapshot?.sync)}): coverage{" "}
            <strong>{formatPercent(stateB.summary.coverageMin)}</strong> min ·
            lost <strong>{stateB.summary.lostByProtocol}</strong> ·{" "}
            {stateB.summary.writesPerItem.toFixed(0)} writes/item
          </span>
        )}
        {(stateA?.error || notice) && (
          <span className="notice" onClick={() => setNotice(null)}>
            {stateA?.error ?? notice}
          </span>
        )}
      </div>

      <main className={`maps ${stateB ? "compare" : ""}`}>
        <MapCanvas
          {...mapProps}
          key={`a-${mapKey}`}
          snapshot={snapshot}
          receivedAt={stateA?.receivedAt ?? 0}
          trace={stateA?.trace ?? null}
          title={stateB ? `A · ${describeSync(snapshot?.sync)}` : undefined}
        />
        {stateB && (
          <MapCanvas
            {...mapProps}
            key={`b-${mapKey}`}
            snapshot={stateB.snapshot}
            receivedAt={stateB.receivedAt}
            trace={stateB.trace}
            title={`B · ${describeSync(stateB.snapshot?.sync)}`}
          />
        )}
      </main>

      <Inspector
        selection={selection}
        detail={stateA?.detail ?? null}
        snapshot={snapshot}
        trace={stateA?.trace ?? null}
        traceTid={traceTid}
        onTrace={setTraceTid}
        onAction={act}
      />

      {settingsOpen && snapshot && (
        <Settings
          params={snapshot.params}
          syncA={snapshot.sync}
          syncB={stateB?.snapshot?.sync ?? null}
          onSync={changeSync}
          seed={run.seed}
          onParams={changeParams}
          onSeed={(seed) => {
            setPlaying(false);
            setRun({ ...run, seed });
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <Charts runs={chartRuns} />
      <EventLog
        log={stateA?.log ?? []}
        devices={snapshot?.devices ?? []}
        onTrace={setTraceTid}
      />

      {contextMenu && (
        <ContextMenuView
          menu={contextMenu}
          snapshot={snapshot}
          onAction={(action) => {
            act(action);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function ContextMenuView({
  menu,
  snapshot,
  onAction,
  onClose,
}: {
  menu: NonNullable<ContextMenu>;
  snapshot: ClientState["snapshot"];
  onAction: (action: ActionBody) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onClose]);

  const items: [string, ActionBody, boolean][] = [];
  if (menu.target.kind === "device") {
    const id = menu.target.id;
    const device = snapshot?.devices.find((entry) => entry.id === id);
    items.push(
      ["Power on", { do: "powerOn", device: id }, device?.power !== "on"],
      ["Bluetooth off", { do: "powerOff", device: id }, device?.power === "on"],
      [
        "Kill app",
        { do: "killApp", device: id },
        device?.power !== "appKilled",
      ],
      ["Factory reset", { do: "factoryReset", device: id }, true],
      ["Scan once", { do: "scan", device: id }, true],
      ["Burst 20 scans", { do: "burst", device: id, count: 20 }, true],
      ["Remove device", { do: "removeDevice", device: id }, true],
    );
  } else {
    const { a, b } = menu.target;
    const key = [a, b].sort().join("|");
    const blocked = snapshot?.blocked.some((pair) => pair.key === key);
    const pinned = snapshot?.links.find((link) => link.key === key)?.pinned;
    items.push(
      [
        blocked ? "Unblock link" : "Cut link",
        { do: blocked ? "unblockLink" : "blockLink", a, b },
        true,
      ],
      [
        pinned ? "Unpin link" : "Pin link",
        { do: pinned ? "unpinLink" : "pinLink", a, b },
        !blocked,
      ],
    );
  }

  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map(([label, action, enabled]) => (
        <button
          key={label}
          disabled={!enabled}
          onClick={() => onAction(action)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
