import { decodeWirePacket } from "@mesh/packets";

import type { Arrival } from "./replica";
import type { Item, PacketKind } from "./types";

/** A missing item counts as lost by protocol once a path to a holder existed this long. */
export const LOST_GRACE_MS = 30_000;
export const SAMPLE_INTERVAL_MS = 1_000;

export type MetricSample = {
  t: number;
  items: number;
  /** Items held by at least one powered device. */
  liveItems: number;
  coverageMean: number;
  coverageMin: number;
  poweredDevices: number;
  converged: boolean;
  /** (device, item) pairs missing although a path to a holder existed for ≥ 30 s. */
  lostByProtocol: number;
  /** (device, item) pairs missing while a path to a holder exists (any duration). */
  missingWithPath: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  writesPerSec: number;
  bytesPerSec: number;
  writes: number;
  bytes: number;
  failedWrites: number;
  writesPerItem: number;
  bytesPerItem: number;
  /** Duplicate receptions per created item (flooding waste). */
  redundancy: number;
  /** Double admissions: extra scans of a ticket made on the same basis. */
  conflicts: number;
};

export type ItemRecord = {
  item: Item;
  authorDevice: string;
  /** Virtual creation time (without the author's clock skew). */
  createdAt: number;
  holders: Map<string, Arrival>;
  lastArrivalAt: number;
};

export type ConvergenceEvent = { disturbedAt: number; convergedAt: number };

type PathState = {
  /** Start of the current stretch with a path to a holder; null while there is none. */
  since: number | null;
  firstPathAt: number | null;
};

/** What metrics need to know about each device at sample time. */
export type DeviceView = {
  id: string;
  powered: boolean;
  linked: boolean;
  component: number;
  has: (tid: string) => boolean;
  heldCount: number;
};

/** Log-spaced latency histogram, 1 ms to ~1 h. */
class LatencyHistogram {
  private static readonly BUCKETS_PER_DECADE = 40;
  private readonly counts = new Array<number>(
    7 * LatencyHistogram.BUCKETS_PER_DECADE,
  ).fill(0);
  total = 0;
  maxValue = 0;

  add(milliseconds: number): void {
    const bucket = Math.min(
      this.counts.length - 1,
      Math.max(
        0,
        Math.floor(
          Math.log10(Math.max(1, milliseconds)) *
            LatencyHistogram.BUCKETS_PER_DECADE,
        ),
      ),
    );
    this.counts[bucket]! += 1;
    this.total += 1;
    this.maxValue = Math.max(this.maxValue, milliseconds);
  }

  quantile(fraction: number): number | null {
    if (this.total === 0) return null;
    const rank = fraction * this.total;
    let seen = 0;
    for (let bucket = 0; bucket < this.counts.length; bucket += 1) {
      seen += this.counts[bucket]!;
      if (seen >= rank) {
        return Math.round(
          Math.pow(10, (bucket + 0.5) / LatencyHistogram.BUCKETS_PER_DECADE),
        );
      }
    }
    return this.maxValue;
  }
}

export class Metrics {
  readonly items = new Map<string, ItemRecord>();
  readonly samples: MetricSample[] = [];
  readonly convergence: ConvergenceEvent[] = [];
  /** Library item key (`author:seq`) → scan tid. */
  private readonly tidByKey = new Map<string, string>();
  private readonly keyByTid = new Map<string, string>();
  /** Device → items whose delivery to it failed on a write. */
  readonly failedDeliveries = new Map<string, Set<string>>();
  private readonly paths = new Map<string, Map<string, PathState>>();
  private readonly latency = new LatencyHistogram();
  /** Ticket → basis (`prev`) → scans made on it. */
  private readonly admissions = new Map<number, Map<string, string[]>>();
  conflicts = 0;
  readonly conflictedTids = new Set<string>();
  writes = 0;
  bytes = 0;
  failedWrites = 0;
  readonly writesByKind: Record<PacketKind, number> = {
    identity: 0,
    item: 0,
    sync: 0,
  };
  readonly bytesByKind: Record<PacketKind, number> = {
    identity: 0,
    item: 0,
    sync: 0,
  };
  duplicates = 0;
  oversizePackets = 0;
  converged = false;
  private pendingDisturbanceAt: number | null = null;
  private lastSampleWrites = 0;
  private lastSampleBytes = 0;
  private lastSampleAt = 0;

  onItemCreated(item: Item, authorDevice: string, at: number): void {
    this.items.set(item.tid, {
      item,
      authorDevice,
      createdAt: at,
      holders: new Map([[authorDevice, { at, via: null, channel: "local" }]]),
      lastArrivalAt: at,
    });
    if (item.action === "scan") {
      const basis = item.prev ?? "";
      let byBasis = this.admissions.get(item.ticketId);
      if (!byBasis) {
        byBasis = new Map();
        this.admissions.set(item.ticketId, byBasis);
      }
      const scans = byBasis.get(basis) ?? [];
      scans.push(item.tid);
      byBasis.set(basis, scans);
      if (scans.length > 1) {
        this.conflicts += 1;
        for (const tid of scans) this.conflictedTids.add(tid);
      }
    }
  }

  onItemArrived(deviceId: string, tid: string, arrival: Arrival): void {
    const record = this.items.get(tid);
    if (!record) return;
    record.holders.set(deviceId, arrival);
    record.lastArrivalAt = Math.max(record.lastArrivalAt, arrival.at);
    this.latency.add(arrival.at - record.createdAt);
    this.paths.get(deviceId)?.delete(tid);
  }

  /** Total duplicate receptions so far (the engine sums its nodes' counters). */
  setDuplicates(total: number): void {
    this.duplicates = total;
  }

  /** The device lost its store (factory reset or removal). */
  forgetHolder(deviceId: string): void {
    for (const record of this.items.values()) {
      record.holders.delete(deviceId);
    }
    this.paths.delete(deviceId);
    this.failedDeliveries.delete(deviceId);
  }

  /** A scan was published as library item `key`. */
  registerItemKey(key: string, tid: string): void {
    this.tidByKey.set(key, tid);
    this.keyByTid.set(tid, key);
  }

  keyOf(tid: string): string | undefined {
    return this.keyByTid.get(tid);
  }

  onWrite(kind: PacketKind, bytes: number, ok: boolean): void {
    if (ok) {
      this.writes += 1;
      this.bytes += bytes;
      this.writesByKind[kind] += 1;
      this.bytesByKind[kind] += bytes;
    } else {
      this.failedWrites += 1;
    }
  }

  /** Remembers which items a failed write was carrying to `deviceId`. */
  onFailedDelivery(deviceId: string, kind: PacketKind, payload: string): void {
    if (kind !== "item") return;
    const tids = (decodeWirePacket(payload)?.parts ?? [])
      .map((part) => this.tidByKey.get(`${part.author}:${part.seq}`))
      .filter((tid): tid is string => tid !== undefined);
    if (tids.length === 0) return;
    let failed = this.failedDeliveries.get(deviceId);
    if (!failed) {
      failed = new Set();
      this.failedDeliveries.set(deviceId, failed);
    }
    for (const tid of tids) failed.add(tid);
  }

  /** A user action (topology, power, parameters): time-to-converge is measured from here. */
  disturb(at: number): void {
    this.pendingDisturbanceAt = at;
  }

  pathState(deviceId: string, tid: string): PathState | undefined {
    return this.paths.get(deviceId)?.get(tid);
  }

  lastConvergenceAfter(at: number): ConvergenceEvent | undefined {
    return [...this.convergence]
      .reverse()
      .find((event) => event.disturbedAt >= at);
  }

  sample(now: number, devices: DeviceView[]): MetricSample {
    const powered = devices.filter((device) => device.powered);
    const total = this.items.size;
    const byComponent = new Map<number, DeviceView[]>();
    for (const device of powered) {
      const members = byComponent.get(device.component) ?? [];
      members.push(device);
      byComponent.set(device.component, members);
    }
    const deviceById = new Map(powered.map((device) => [device.id, device]));

    let liveItems = 0;
    let missingWithPath = 0;
    let lostByProtocol = 0;
    const touched = new Set<string>();
    for (const [tid, record] of this.items) {
      const holderComponents = new Set<number>();
      for (const holder of record.holders.keys()) {
        const device = deviceById.get(holder);
        if (device) holderComponents.add(device.component);
      }
      if (holderComponents.size === 0) continue;
      liveItems += 1;
      for (const component of holderComponents) {
        for (const device of byComponent.get(component) ?? []) {
          if (device.has(tid)) continue;
          let devicePaths = this.paths.get(device.id);
          if (!devicePaths) {
            devicePaths = new Map();
            this.paths.set(device.id, devicePaths);
          }
          let state = devicePaths.get(tid);
          if (!state) {
            state = { since: null, firstPathAt: null };
            devicePaths.set(tid, state);
          }
          state.since ??= now;
          state.firstPathAt ??= now;
          touched.add(`${device.id}\u0000${tid}`);
          missingWithPath += 1;
          if (now - state.since >= LOST_GRACE_MS) lostByProtocol += 1;
        }
      }
    }
    // Pairs with no path this sample: the current stretch ends.
    for (const [deviceId, devicePaths] of this.paths) {
      for (const [tid, state] of devicePaths) {
        if (state.since !== null && !touched.has(`${deviceId}\u0000${tid}`)) {
          state.since = null;
        }
      }
    }

    let coverageSum = 0;
    let coverageMin = powered.length > 0 ? 1 : 0;
    for (const device of powered) {
      const coverage = total === 0 ? 1 : device.heldCount / total;
      coverageSum += coverage;
      coverageMin = Math.min(coverageMin, coverage);
    }

    // A powered device holds only live items, so "has every live item" is a count check.
    const converged = powered
      .filter((device) => device.linked)
      .every((device) => device.heldCount === liveItems);
    if (converged && this.pendingDisturbanceAt !== null) {
      this.convergence.push({
        disturbedAt: this.pendingDisturbanceAt,
        convergedAt: now,
      });
      this.pendingDisturbanceAt = null;
    }
    this.converged = converged;

    const elapsedSeconds = Math.max(0.001, (now - this.lastSampleAt) / 1000);
    const sample: MetricSample = {
      t: now,
      items: total,
      liveItems,
      coverageMean: powered.length > 0 ? coverageSum / powered.length : 0,
      coverageMin,
      poweredDevices: powered.length,
      converged,
      lostByProtocol,
      missingWithPath,
      p50: this.latency.quantile(0.5),
      p95: this.latency.quantile(0.95),
      max: this.latency.total > 0 ? Math.round(this.latency.maxValue) : null,
      writesPerSec: (this.writes - this.lastSampleWrites) / elapsedSeconds,
      bytesPerSec: (this.bytes - this.lastSampleBytes) / elapsedSeconds,
      writes: this.writes,
      bytes: this.bytes,
      failedWrites: this.failedWrites,
      writesPerItem: total > 0 ? this.writes / total : 0,
      bytesPerItem: total > 0 ? this.bytes / total : 0,
      redundancy: total > 0 ? this.duplicates / total : 0,
      conflicts: this.conflicts,
    };
    this.lastSampleWrites = this.writes;
    this.lastSampleBytes = this.bytes;
    this.lastSampleAt = now;
    this.samples.push(sample);
    return sample;
  }
}
