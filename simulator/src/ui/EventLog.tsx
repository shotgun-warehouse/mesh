import { useMemo, useState } from "react";

import type { SnapshotDevice } from "../engine/engine";
import type { LogLevel, LogLine } from "../engine/types";
import { formatTime } from "./format";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const MAX_ROWS = 400;

type Props = {
  log: LogLine[];
  devices: SnapshotDevice[];
  onTrace: (tid: string) => void;
};

/** Event log: engine events (links, scans, failed writes, actions) and every router's own log. */
export function EventLog({ log, devices, onTrace }: Props) {
  const [device, setDevice] = useState("");
  const [tag, setTag] = useState("");
  const [level, setLevel] = useState<LogLevel>("info");
  const [source, setSource] = useState<"all" | "engine" | "router">("engine");

  const labels = useMemo(
    () => new Map(devices.map((entry) => [entry.id, entry.label])),
    [devices],
  );
  const rows = useMemo(() => {
    const minimum = LEVELS.indexOf(level);
    const needle = tag.trim().toLowerCase();
    const matches: LogLine[] = [];
    for (
      let index = log.length - 1;
      index >= 0 && matches.length < MAX_ROWS;
      index -= 1
    ) {
      const line = log[index]!;
      if (LEVELS.indexOf(line.level) < minimum) continue;
      if (device && line.device !== device) continue;
      if (source !== "all" && line.source !== source) continue;
      if (
        needle &&
        !line.tag.toLowerCase().includes(needle) &&
        !line.message.toLowerCase().includes(needle)
      )
        continue;
      matches.push(line);
    }
    return matches;
  }, [log, device, tag, level, source]);

  return (
    <section className="event-log">
      <div className="log-filters">
        <strong>Event log</strong>
        <select
          value={source}
          onChange={(event) => setSource(event.target.value as typeof source)}
        >
          <option value="engine">Engine events</option>
          <option value="router">Router logs</option>
          <option value="all">Everything</option>
        </select>
        <select
          value={device}
          onChange={(event) => setDevice(event.target.value)}
        >
          <option value="">All devices</option>
          {devices.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <input
          placeholder="Tag or text"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
        />
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel)}
        >
          {LEVELS.map((entry) => (
            <option key={entry} value={entry}>
              ≥ {entry}
            </option>
          ))}
        </select>
        <span className="muted">
          {rows.length === MAX_ROWS
            ? `latest ${MAX_ROWS}`
            : `${rows.length} lines`}
        </span>
      </div>
      <div className="log-rows mono">
        {rows.map((line) => {
          const tid = line.detail
            ? /"tid":"([^"]+)"/.exec(line.detail)?.[1]
            : undefined;
          return (
            <div key={line.seq} className={`log-row log-${line.level}`}>
              <span className="muted">{formatTime(line.t)}</span>
              <span className="log-device">
                {line.device ? (labels.get(line.device) ?? line.device) : "—"}
              </span>
              <span className="log-tag">{line.tag}</span>
              <span>
                {line.message}
                {tid && (
                  <button className="link-button" onClick={() => onTrace(tid)}>
                    trace
                  </button>
                )}
                {line.detail && line.source === "router" && (
                  <span className="muted"> {line.detail}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
