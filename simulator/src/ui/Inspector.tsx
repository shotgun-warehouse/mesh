import { useState } from "react";

import type {
  DeviceDetail,
  ItemTrace,
  LinkDetail,
  Snapshot,
} from "../engine/engine";
import { LATENCY_BUCKET_MS } from "../engine/medium";
import type { ActionBody, PowerState } from "../engine/types";
import type { Detail } from "../protocol";
import {
  authorColor,
  formatBytes,
  formatMs,
  formatPercent,
  formatShortTime,
  POWER_LABEL,
} from "./format";
import type { Selection } from "./MapCanvas";

type Props = {
  selection: Selection;
  detail: Detail;
  snapshot: Snapshot | null;
  trace: ItemTrace | null;
  traceTid: string | null;
  onTrace: (tid: string | null) => void;
  onAction: (action: ActionBody) => void;
};

export function Inspector({
  selection,
  detail,
  snapshot,
  trace,
  traceTid,
  onTrace,
  onAction,
}: Props) {
  return (
    <aside className="inspector">
      {traceTid && (
        <TracePanel
          trace={trace}
          snapshot={snapshot}
          onClose={() => onTrace(null)}
        />
      )}
      {!selection && !traceTid && <EmptyInspector />}
      {selection?.kind === "wall" && (
        <WallPanel id={selection.id} onAction={onAction} />
      )}
      {selection?.kind === "device" &&
        detail?.kind === "device" &&
        detail.detail.id === selection.id && (
          <DevicePanel
            detail={detail.detail}
            now={snapshot?.t ?? 0}
            repair={snapshot?.sync.repair !== false}
            onAction={onAction}
            onTrace={onTrace}
            traceTid={traceTid}
          />
        )}
      {selection?.kind === "link" && detail?.kind === "link" && (
        <LinkPanel
          detail={detail.detail}
          snapshot={snapshot}
          onAction={onAction}
        />
      )}
    </aside>
  );
}

function EmptyInspector() {
  return (
    <div className="panel muted">
      <h2>Inspector</h2>
      <p>Select a device or a link on the map.</p>
      <ul className="hints">
        <li>
          <kbd>V</kbd> select / drag · <kbd>A</kbd> add device · <kbd>X</kbd>{" "}
          cut link · <kbd>W</kbd> draw wall
        </li>
        <li>
          <kbd>S</kbd> scan on the selected device · <kbd>⌫</kbd> delete ·{" "}
          <kbd>Space</kbd> play/pause · <kbd>F</kbd> fit
        </li>
        <li>Right-click a device for power, kill, factory reset and bursts.</li>
      </ul>
    </div>
  );
}

function WallPanel({
  id,
  onAction,
}: {
  id: string;
  onAction: (action: ActionBody) => void;
}) {
  return (
    <div className="panel">
      <h2>Wall</h2>
      <p className="muted">No link can cross a wall.</p>
      <button onClick={() => onAction({ do: "removeWall", id })}>
        Remove wall
      </button>
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DevicePanel({
  detail,
  now,
  repair,
  onAction,
  onTrace,
  traceTid,
}: {
  detail: DeviceDetail;
  now: number;
  repair: boolean;
  onAction: (action: ActionBody) => void;
  onTrace: (tid: string | null) => void;
  traceTid: string | null;
}) {
  const [itemFilter, setItemFilter] = useState("");
  const power = (value: PowerState) =>
    onAction({ do: "setPower", device: detail.id, power: value });
  const items = itemFilter
    ? detail.replica.items.filter(
        (item) =>
          String(item.ticketId) === itemFilter ||
          item.authorLabel.toLowerCase().includes(itemFilter.toLowerCase()),
      )
    : detail.replica.items;

  return (
    <div className="panel">
      <header className="panel-header">
        <div>
          <h2>{detail.label}</h2>
          <div className="muted mono">
            {detail.meshId} · {detail.platform} · max {detail.maxLinks} links
          </div>
        </div>
        <span className={`pill power-${detail.power}`}>
          {POWER_LABEL[detail.power]}
        </span>
      </header>

      <div className="button-row">
        <button disabled={detail.power === "on"} onClick={() => power("on")}>
          Power on
        </button>
        <button
          disabled={detail.power !== "on"}
          onClick={() => power("bluetoothOff")}
        >
          Bluetooth off
        </button>
        <button
          disabled={detail.power === "appKilled"}
          onClick={() => onAction({ do: "killApp", device: detail.id })}
        >
          Kill app
        </button>
        <button onClick={() => onAction({ do: "scan", device: detail.id })}>
          Scan
        </button>
        <button
          onClick={() =>
            onAction({ do: "burst", device: detail.id, count: 20 })
          }
        >
          Burst 20
        </button>
      </div>

      <Section title="Radio and router">
        <div className="stats">
          <Stat label="Peers (router)" value={detail.peerCount} />
          <Stat label="Write queue" value={detail.writeQueue} />
          <Stat
            label="Router pending queue"
            value={detail.router?.pendingQueue ?? "–"}
          />
          <Stat
            label="Dedup cache"
            value={detail.router ? `${detail.router.dedupSize} / 500` : "–"}
          />
          <Stat label="Clock skew" value={`${detail.clockSkewMs} ms`} />
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Link</th>
              <th>State</th>
              <th>RSSI</th>
              <th>Up for</th>
            </tr>
          </thead>
          <tbody>
            {detail.links.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No links
                </td>
              </tr>
            )}
            {detail.links.map((link) => (
              <tr key={link.peer}>
                <td>
                  {link.label} {link.pinned && "🔒"}
                </td>
                <td>{link.state}</td>
                <td>{link.rssi} dBm</td>
                <td>
                  {link.upSince === null
                    ? "–"
                    : formatShortTime(Math.max(0, now - link.upSince))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={`Replica · ${detail.replica.count} items · ${formatPercent(detail.replica.coverage)}`}
      >
        <div className="stats">
          <Stat
            label="Digest"
            value={
              <span className="mono">
                {detail.replica.digest.xor.toString(16).padStart(8, "0")} /{" "}
                {detail.replica.digest.count}
              </span>
            }
          />
          <Stat label="Duplicates received" value={detail.replica.duplicates} />
        </div>
        <h3>Version vector</h3>
        <VersionVectorTable vector={detail.replica.versionVector} />
      </Section>

      <Section
        title={`Why am I missing this? · ${detail.missingTotal}`}
        defaultOpen={detail.missingTotal > 0}
      >
        {detail.missingTotal === 0 && <p className="muted">Nothing missing.</p>}
        <ul className="missing">
          {detail.missing.map((missing) => (
            <li key={missing.tid}>
              <button
                className="link-button mono"
                onClick={() => onTrace(missing.tid)}
              >
                #{missing.ticketId} by {missing.author}
              </button>{" "}
              <span className="muted">
                at {formatShortTime(missing.createdAt)}
              </span>
              <ul>
                {missing.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {detail.missingTotal > detail.missing.length && (
          <p className="muted">
            Showing the {detail.missing.length} most recent of{" "}
            {detail.missingTotal}.
          </p>
        )}
      </Section>

      {repair && (
        <Section
          title="Sync explainer"
          defaultOpen={detail.explanations.length > 0}
        >
          {detail.explanations.length === 0 && (
            <p className="muted">No exchange yet.</p>
          )}
          {detail.explanations.slice(0, 8).map((entry, index) => (
            <SyncExplanationView
              key={`${entry.at}-${index}`}
              entry={entry}
              me={detail.label}
            />
          ))}
        </Section>
      )}

      <Section title="Items" defaultOpen={false}>
        <input
          className="filter"
          placeholder="Filter by ticket # or author"
          value={itemFilter}
          onChange={(event) => setItemFilter(event.target.value)}
        />
        <table className="table items">
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Author</th>
              <th>Seq</th>
              <th>Created</th>
              <th>Arrived</th>
              <th>Via</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 200).map((item) => (
              <tr
                key={item.tid}
                className={item.tid === traceTid ? "selected-row" : undefined}
                onClick={() => onTrace(item.tid === traceTid ? null : item.tid)}
              >
                <td>
                  #{item.ticketId} {item.action === "checkout" ? "↩" : ""}
                  {item.conflict && (
                    <span className="pill bad" title="Double admission">
                      conflict
                    </span>
                  )}
                </td>
                <td>
                  <span
                    className="swatch"
                    style={{ background: authorColor(item.author) }}
                  />
                  {item.authorLabel}
                </td>
                <td>{item.seq}</td>
                <td>{formatShortTime(item.createdAt)}</td>
                <td>{formatShortTime(item.arrivedAt)}</td>
                <td className="muted">
                  {item.channel === "local" ? "local" : `${item.channel}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Device log" defaultOpen={false}>
        <div className="device-log mono">
          {detail.log
            .slice(-150)
            .reverse()
            .map((line) => (
              <div key={line.seq} className={`log-${line.level}`}>
                <span className="muted">{formatShortTime(line.t)}</span> [
                {line.tag}] {line.message}
                {line.detail && <span className="muted"> {line.detail}</span>}
              </div>
            ))}
        </div>
      </Section>
    </div>
  );
}

function VersionVectorTable({
  vector,
  other,
}: {
  vector: Record<string, number>;
  other?: Record<string, number>;
}) {
  const authors = [
    ...new Set([...Object.keys(vector), ...Object.keys(other ?? {})]),
  ].sort();
  if (authors.length === 0) return <p className="muted">Empty</p>;
  return (
    <table className="table vv">
      <thead>
        <tr>
          <th>Author</th>
          <th>{other ? "Mine" : "Max seq"}</th>
          {other && <th>Theirs</th>}
        </tr>
      </thead>
      <tbody>
        {authors.map((author) => {
          const mine = vector[author] ?? 0;
          const theirs = other?.[author] ?? 0;
          return (
            <tr key={author}>
              <td className="mono">
                <span
                  className="swatch"
                  style={{ background: authorColor(author) }}
                />
                {author}
              </td>
              <td className={other && mine < theirs ? "bad-text" : undefined}>
                {mine}
              </td>
              {other && (
                <td className={theirs < mine ? "bad-text" : undefined}>
                  {theirs}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SyncExplanationView({
  entry,
  me,
}: {
  entry: DeviceDetail["explanations"][number];
  me: string;
}) {
  return (
    <div className="explanation">
      <div>
        <strong>{formatShortTime(entry.at)}</strong> exchange with{" "}
        <span className="mono">{entry.peer}</span>
      </div>
      <VersionVectorTable vector={entry.mine} other={entry.theirs} />
      {entry.requested.length === 0 ? (
        <p className="muted">{me} is not behind: asks for nothing.</p>
      ) : (
        <p>
          {me} is behind: asks for{" "}
          {entry.requested.map(([author, from, to]) => (
            <span key={author} className="mono range">
              {author.slice(0, 4)}:{from}
              {to > from ? `–${to}` : ""}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function LinkPanel({
  detail,
  snapshot,
  onAction,
}: {
  detail: LinkDetail;
  snapshot: Snapshot | null;
  onAction: (action: ActionBody) => void;
}) {
  const label = (id: string) =>
    snapshot?.devices.find((device) => device.id === id)?.label ?? id;
  const maxBucket = Math.max(1, ...detail.latencyBuckets);
  return (
    <div className="panel">
      <header className="panel-header">
        <div>
          <h2>
            {label(detail.a)} ↔ {label(detail.b)}
          </h2>
          <div className="muted">
            {detail.meters.toFixed(1)} m · {detail.rssi} dBm
          </div>
        </div>
        <span className="pill">
          {detail.blocked ? "blocked" : detail.state}
        </span>
      </header>
      <div className="button-row">
        {detail.blocked ? (
          <button
            onClick={() =>
              onAction({ do: "unblockLink", a: detail.a, b: detail.b })
            }
          >
            Unblock
          </button>
        ) : (
          <button
            onClick={() =>
              onAction({ do: "blockLink", a: detail.a, b: detail.b })
            }
          >
            Cut (block)
          </button>
        )}
        {detail.pinned ? (
          <button
            onClick={() =>
              onAction({ do: "unpinLink", a: detail.a, b: detail.b })
            }
          >
            Unpin
          </button>
        ) : (
          <button
            onClick={() =>
              onAction({ do: "pinLink", a: detail.a, b: detail.b })
            }
          >
            Pin (never drops)
          </button>
        )}
      </div>
      <div className="stats">
        <Stat
          label="Up for"
          value={
            detail.upSince === null || !snapshot
              ? "–"
              : formatMs(snapshot.t - detail.upSince)
          }
        />
        <Stat label="Connections" value={detail.connections} />
        <Stat label="Writes OK" value={detail.writesOk} />
        <Stat label="Writes failed" value={detail.writesFailed} />
        <Stat label="Bytes" value={formatBytes(detail.bytes)} />
      </div>
      <h3>Write latency</h3>
      <div className="histogram">
        {detail.latencyBuckets.map((count, index) => (
          <div
            key={index}
            className="bar"
            title={`${index * LATENCY_BUCKET_MS}–${(index + 1) * LATENCY_BUCKET_MS} ms: ${count}`}
            style={{ height: `${(count / maxBucket) * 100}%` }}
          />
        ))}
      </div>
      <div className="histogram-axis muted">
        <span>0</span>
        <span>{(detail.latencyBuckets.length * LATENCY_BUCKET_MS) / 2} ms</span>
        <span>{detail.latencyBuckets.length * LATENCY_BUCKET_MS}+ ms</span>
      </div>
    </div>
  );
}

function TracePanel({
  trace,
  snapshot,
  onClose,
}: {
  trace: ItemTrace | null;
  snapshot: Snapshot | null;
  onClose: () => void;
}) {
  const label = (id: string | null) =>
    id
      ? (snapshot?.devices.find((device) => device.id === id)?.label ?? id)
      : "–";
  return (
    <div className="panel trace">
      <header className="panel-header">
        <h2>Item trace</h2>
        <button onClick={onClose}>Close</button>
      </header>
      {!trace ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p>
            Ticket <strong>#{trace.item.ticketId}</strong> ({trace.item.action})
            by <strong>{label(trace.authorDevice)}</strong>, at{" "}
            {formatShortTime(trace.createdAt)}.
          </p>
          <p className="muted mono">{trace.tid}</p>
          <table className="table">
            <thead>
              <tr>
                <th>Holder</th>
                <th>After</th>
                <th>From</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {trace.holders.map((holder) => (
                <tr key={holder.device}>
                  <td>{label(holder.device)}</td>
                  <td>{formatMs(holder.at - trace.createdAt)}</td>
                  <td>{label(holder.via)}</td>
                  <td className="muted">{holder.channel}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trace.neverReached.length > 0 && (
            <p>
              <strong className="bad-text">Never reached:</strong>{" "}
              {trace.neverReached.map(label).join(", ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
