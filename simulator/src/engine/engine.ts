import { DEVICE_ID_BYTES } from "@mesh/constants";
import type { MeshLogLevel } from "@mesh/logger";
import { resolveSyncOptions, type MeshSyncOptions } from "@sync/sync";
import type { MeshItem } from "@sync/types";

import { drainMicrotasks, SETTLE_DRAIN_TURNS, VirtualClock } from "./clock";
import {
  Medium,
  pairKey,
  peerOf,
  rssiAt,
  type Link,
  type LinkDownReason,
} from "./medium";
import {
  LOST_GRACE_MS,
  Metrics,
  SAMPLE_INTERVAL_MS,
  type DeviceView,
  type MetricSample,
} from "./metrics";
import {
  exponential,
  fnv1a,
  randomHex,
  RandomStreams,
  type Rng,
} from "./random";
import type { Arrival } from "./replica";
import { SimNode, type NodeWorld } from "./simNode";
import type {
  InFlightPacket,
  SimTransport,
  WriteOutcome,
} from "./simTransport";
import type {
  Action,
  ActionBody,
  DeviceSpec,
  Item,
  LogLevel,
  LogLine,
  NetworkParams,
  PowerState,
  RunConfig,
  RunFile,
} from "./types";

/** Device-level churn (Bluetooth toggles, app kills) is rolled this often. */
const CHURN_TICK_MS = 1_000;
const BLUETOOTH_OFF_MS: [number, number] = [10_000, 60_000];
const APP_DEAD_MS: [number, number] = [5_000, 30_000];
/** Share of scans of an admitted ticket that check it out (the rest are refused re-entries). */
const CHECKOUT_PROBABILITY = 0.3;
/** Packets stay in the snapshot this long after they end, for the failure burst. */
const PACKET_LINGER_MS = 400;
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type EngineOptions = {
  /** Router log lines below this level are not captured (they still run). */
  routerLogLevel?: LogLevel;
  /** Log lines kept for the UI. */
  maxLogLines?: number;
};

export type SnapshotDevice = {
  id: string;
  meshId: string;
  label: string;
  x: number;
  y: number;
  platform: "ios" | "android";
  power: PowerState;
  held: number;
  missing: number;
  coverage: number;
  queueDepth: number;
  linkCount: number;
  maxLinks: number;
};

export type SnapshotLink = {
  key: string;
  a: string;
  b: string;
  state: Link["state"];
  pinned: boolean;
  traffic: number;
  lastFailAt: number | null;
};

export type SnapshotPacket = {
  id: number;
  from: string;
  to: string;
  kind: InFlightPacket["kind"];
  start: number;
  end: number;
  failed: boolean;
};

export type Snapshot = {
  t: number;
  fired: number;
  seed: number;
  /** Sync knobs this run uses (omitted fields are the library defaults). */
  sync: MeshSyncOptions;
  preset: string | null;
  params: NetworkParams;
  devices: SnapshotDevice[];
  links: SnapshotLink[];
  blocked: { key: string; a: string; b: string }[];
  walls: RunConfig["walls"];
  packets: SnapshotPacket[];
  latest: MetricSample | null;
  /** Samples after `sampleCursor` (see `snapshot`). */
  samples: MetricSample[];
  sampleCursor: number;
  log: LogLine[];
  logCursor: number;
  converged: boolean;
  oversizePackets: number;
};

export type MissingItem = {
  tid: string;
  author: string;
  ticketId: number;
  createdAt: number;
  reasons: string[];
};

export type DeviceDetail = {
  id: string;
  meshId: string;
  label: string;
  platform: "ios" | "android";
  power: PowerState;
  position: { x: number; y: number };
  clockSkewMs: number;
  maxLinks: number;
  peerCount: number;
  links: {
    peer: string;
    label: string;
    state: Link["state"];
    rssi: number;
    upSince: number | null;
    pinned: boolean;
  }[];
  writeQueue: number;
  router: ReturnType<SimNode["routerInternals"]>;
  replica: {
    count: number;
    coverage: number;
    duplicates: number;
    digest: { xor: number; count: number };
    versionVector: Record<string, number>;
    items: {
      tid: string;
      author: string;
      authorLabel: string;
      /** Library item seq (known once the author's publish landed). */
      seq: string;
      ticketId: number;
      action: Item["action"];
      createdAt: number;
      arrivedAt: number;
      via: string | null;
      channel: string;
      conflict: boolean;
    }[];
  };
  missing: MissingItem[];
  missingTotal: number;
  explanations: SimNode["explanations"];
  log: LogLine[];
};

export type LinkDetail = {
  key: string;
  a: string;
  b: string;
  state: Link["state"] | "none";
  upSince: number | null;
  pinned: boolean;
  blocked: boolean;
  meters: number;
  rssi: number;
  writesOk: number;
  writesFailed: number;
  bytes: number;
  connections: number;
  latencyBuckets: number[];
};

export type ItemTrace = {
  tid: string;
  item: Item;
  authorDevice: string;
  createdAt: number;
  holders: {
    device: string;
    at: number;
    via: string | null;
    channel: string;
  }[];
  neverReached: string[];
};

export type RunSummary = {
  t: number;
  items: number;
  coverageMean: number;
  coverageMin: number;
  converged: boolean;
  lostByProtocol: number;
  maxLostByProtocol: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  writes: number;
  bytes: number;
  failedWrites: number;
  writesPerItem: number;
  bytesPerItem: number;
  redundancy: number;
  conflicts: number;
  /** Time from the last user action to the first converged sample after it; null if never. */
  convergedWithinMs: number | null;
  writesByKind: Metrics["writesByKind"];
  oversizePackets: number;
};

function cloneConfig(config: RunConfig): RunConfig {
  return JSON.parse(JSON.stringify(config)) as RunConfig;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One simulation run: virtual clock, seeded randomness, the medium and N virtual phones running
 * the real router. A run is `{ seed, config, actions }`; replaying it gives the same run.
 * No DOM: it runs in a Web Worker, in Vitest and in the Node bench.
 */
export class Engine implements NodeWorld {
  readonly random: RandomStreams;
  readonly clock: VirtualClock;
  readonly medium: Medium;
  readonly metrics = new Metrics();
  readonly config: RunConfig;
  readonly nodes = new Map<string, SimNode>();
  /** Every action applied so far, in order (replayed and live). */
  readonly actions: Action[] = [];
  private readonly pending: Action[];
  private readonly meshIndex = new Map<string, string>();
  private packets: InFlightPacket[] = [];
  private nextPacketId = 1;
  private readonly logLines: LogLine[] = [];
  private nextLogSeq = 1;
  private hash = 0x811c9dc5;
  private readonly routerLogLevel: number;
  private readonly maxLogLines: number;
  private readonly scanTimers = new Map<string, number>();
  private readonly churnRestore = new Map<string, number>();
  private maxLostByProtocol = 0;
  private started = false;
  /** Scan tid → the scope it was published in. */
  readonly itemScopes = new Map<string, string>();
  /** Items handed to a device whose scope is not the one they were published in (must stay 0). */
  crossScopeArrivals = 0;

  readonly lossRng: Rng;

  constructor(
    readonly run: RunFile,
    options: EngineOptions = {},
  ) {
    this.random = new RandomStreams(run.seed);
    this.lossRng = this.random.loss;
    this.clock = new VirtualClock(this.random.uuid);
    this.config = cloneConfig(run.config);
    this.routerLogLevel = LEVEL_ORDER[options.routerLogLevel ?? "info"];
    this.maxLogLines = options.maxLogLines ?? 5_000;
    this.pending = [...run.actions].sort((left, right) =>
      left.event !== undefined && right.event !== undefined
        ? left.event - right.event
        : left.at - right.at,
    );
    this.medium = new Medium(
      this.config.params,
      () => this.clock.now,
      this.random.medium,
      () => this.nodes.values(),
      (id) => this.nodes.get(id),
      {
        onLinkUp: (link) => this.handleLinkUp(link),
        onLinkDown: (link, reason) => this.handleLinkDown(link, reason),
      },
    );
  }

  static async create(run: RunFile, options?: EngineOptions): Promise<Engine> {
    const engine = new Engine(run, options);
    await engine.start();
    return engine;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.clock.run(async () => {
      this.medium.walls.push(...this.config.walls);
      for (const spec of this.config.devices) {
        this.createNode(spec);
      }
      this.medium.start();
      setInterval(() => this.takeSample(), SAMPLE_INTERVAL_MS);
      setInterval(() => this.rollDeviceChurn(), CHURN_TICK_MS);
      for (const spec of this.config.devices) {
        await this.nodes.get(spec.id)!.setPower(spec.power ?? "on");
      }
      await this.drainDueActions(0);
    });
  }

  // ─── NodeWorld / TransportWorld ────────────────────────────────────────────

  now(): number {
    return this.clock.now;
  }

  params(): NetworkParams {
    return this.config.params;
  }

  syncOptions(): MeshSyncOptions {
    return this.config.sync;
  }

  meshIdOf(deviceId: string): string {
    return this.nodes.get(deviceId)?.meshId ?? deviceId;
  }

  labelOf(deviceId: string): string {
    return this.nodes.get(deviceId)?.label ?? deviceId;
  }

  deviceIdOfMesh(meshId: string): string | undefined {
    return this.meshIndex.get(meshId);
  }

  transportOf(deviceId: string): SimTransport | undefined {
    const node = this.nodes.get(deviceId);
    return node && node.power === "on" ? node.transport : undefined;
  }

  beginPacket(packet: Omit<InFlightPacket, "id">): InFlightPacket {
    const started: InFlightPacket = { ...packet, id: this.nextPacketId++ };
    this.packets.push(started);
    return started;
  }

  endPacket(packet: InFlightPacket, outcome: WriteOutcome): void {
    packet.end = this.clock.now;
    packet.failed = outcome !== "ok";
    this.metrics.onWrite(packet.kind, packet.bytes, outcome === "ok");
    if (outcome !== "ok") {
      this.metrics.onFailedDelivery(packet.to, packet.kind, packet.wirePayload);
      if (outcome !== "poweredDown") {
        this.event(
          packet.from,
          "write",
          `Write to ${this.labelOf(packet.to)} failed (${outcome})`,
          {
            kind: packet.kind,
            bytes: packet.bytes,
          },
        );
      }
    }
  }

  onOversizePacket(deviceId: string, bytes: number): void {
    this.metrics.oversizePackets += 1;
    this.event(
      deviceId,
      "write",
      `Rejected a ${bytes}-byte packet (over the ATT limit)`,
      undefined,
      "error",
    );
  }

  log(
    deviceId: string,
    tag: string,
    message: string,
    detail: Record<string, unknown> | undefined,
    level: MeshLogLevel,
  ): void {
    if (LEVEL_ORDER[level] < this.routerLogLevel) return;
    this.pushLog(deviceId, tag, message, detail, level);
  }

  onItemCreated(node: SimNode, item: Item): void {
    this.metrics.onItemCreated(item, node.id, this.clock.now);
    this.event(
      node.id,
      "item",
      `Scanned ticket #${item.ticketId} (${item.action})`,
      { tid: item.tid },
    );
  }

  onItemPublished(node: SimNode, item: Item, meshItem: MeshItem): void {
    const scope = node.itemSync.currentScope;
    if (scope !== null) this.itemScopes.set(item.tid, scope);
    this.metrics.registerItemKey(
      `${meshItem.author}:${meshItem.seq}`,
      item.tid,
    );
    this.hashText(
      `published ${node.id} ${item.tid} ${meshItem.author}:${meshItem.seq}`,
    );
  }

  onItemArrived(node: SimNode, item: Item, arrival: Arrival): void {
    const scope = this.itemScopes.get(item.tid);
    if (scope !== undefined && scope !== node.itemSync.currentScope) {
      this.crossScopeArrivals += 1;
    }
    this.metrics.onItemArrived(node.id, item.tid, arrival);
    this.hashText(
      `arrive ${this.clock.now} ${node.id} ${item.tid} ${arrival.via} ${arrival.channel}`,
    );
  }

  // ─── Running ───────────────────────────────────────────────────────────────

  /** Runs virtual time up to `target` ms, applying recorded actions at their exact positions. */
  async advanceTo(target: number): Promise<void> {
    await this.clock.run(async () => {
      for (;;) {
        if (await this.applyNextDueAction(target)) continue;
        const nextTimer = this.clock.nextTimerAt();
        if (nextTimer === null || nextTimer > target) break;
        await this.clock.fireNext();
      }
      this.clock.setNow(target);
    });
  }

  async advanceBy(milliseconds: number): Promise<void> {
    await this.advanceTo(this.clock.now + milliseconds);
  }

  /** Fires exactly one timer (one event). */
  async step(): Promise<void> {
    await this.clock.run(async () => {
      const nextTimer = this.clock.nextTimerAt();
      if (await this.applyNextDueAction(nextTimer ?? this.clock.now)) return;
      await this.clock.fireNext();
    });
  }

  /** Applies a user action now and records it for replay. */
  async applyLive(body: ActionBody): Promise<void> {
    const action = {
      ...body,
      at: this.clock.now,
      event: this.clock.fired,
    } as Action;
    await this.clock.run(async () => {
      await drainMicrotasks(SETTLE_DRAIN_TURNS);
      await this.apply(action);
      await drainMicrotasks(SETTLE_DRAIN_TURNS);
    });
  }

  exportRun(): RunFile {
    return {
      seed: this.run.seed,
      config: cloneConfig(this.run.config),
      actions: [...this.actions, ...this.pending].map((action) => ({
        ...action,
      })),
    };
  }

  /** Hash of the event log and captured router logs: equal runs give equal hashes. */
  eventLogHash(): string {
    return this.hash.toString(16).padStart(8, "0");
  }

  dispose(): void {
    this.clock.enter();
    try {
      this.medium.stop();
      for (const node of this.nodes.values()) {
        node.itemSync.detach();
        void node.router?.stop();
      }
    } finally {
      this.clock.exit();
    }
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  get converged(): boolean {
    return this.metrics.converged;
  }

  latestSample(): MetricSample | null {
    return this.metrics.samples[this.metrics.samples.length - 1] ?? null;
  }

  summary(): RunSummary {
    const latest = this.latestSample();
    const lastAction = this.actions[this.actions.length - 1];
    const lastConvergence = this.metrics.lastConvergenceAfter(
      lastAction?.at ?? 0,
    );
    return {
      t: this.clock.now,
      items: this.metrics.items.size,
      coverageMean: latest?.coverageMean ?? 0,
      coverageMin: latest?.coverageMin ?? 0,
      converged: this.metrics.converged,
      lostByProtocol: latest?.lostByProtocol ?? 0,
      maxLostByProtocol: this.maxLostByProtocol,
      p50: latest?.p50 ?? null,
      p95: latest?.p95 ?? null,
      max: latest?.max ?? null,
      writes: this.metrics.writes,
      bytes: this.metrics.bytes,
      failedWrites: this.metrics.failedWrites,
      writesPerItem: latest?.writesPerItem ?? 0,
      bytesPerItem: latest?.bytesPerItem ?? 0,
      redundancy: latest?.redundancy ?? 0,
      conflicts: this.metrics.conflicts,
      convergedWithinMs: lastConvergence
        ? lastConvergence.convergedAt - lastConvergence.disturbedAt
        : null,
      writesByKind: { ...this.metrics.writesByKind },
      oversizePackets: this.metrics.oversizePackets,
    };
  }

  snapshot(sampleCursor: number, logCursor: number): Snapshot {
    const now = this.clock.now;
    this.prunePackets();
    const total = this.metrics.items.size;
    const devices: SnapshotDevice[] = [...this.nodes.values()].map((node) => ({
      id: node.id,
      meshId: node.meshId,
      label: node.label,
      x: node.position.x,
      y: node.position.y,
      platform: node.platform,
      power: node.power,
      held: node.replica.size,
      missing: Math.max(0, total - node.replica.size),
      coverage: total === 0 ? 1 : node.replica.size / total,
      queueDepth:
        node.transport.queuedJobs + (node.routerInternals()?.pendingQueue ?? 0),
      linkCount: this.medium.readyLinksOf(node.id).length,
      maxLinks: node.maxLinks,
    }));
    const links: SnapshotLink[] = [...this.medium.links.values()].map(
      (link) => {
        const stats = this.medium.pairStats.get(link.key);
        return {
          key: link.key,
          a: link.a,
          b: link.b,
          state: link.state,
          pinned: this.medium.pinned.has(link.key),
          traffic: this.medium.trafficOf(link.key, now),
          lastFailAt: stats?.lastFailAt ?? null,
        };
      },
    );
    const blocked = [...this.medium.blocked].map((key) => {
      const [a, b] = key.split("|") as [string, string];
      return { key, a, b };
    });
    const samples = this.metrics.samples.slice(sampleCursor);
    const log = this.logLines
      .filter((line) => line.seq > logCursor)
      .slice(-400);
    return {
      t: now,
      fired: this.clock.fired,
      seed: this.run.seed,
      sync: { ...this.config.sync },
      preset: this.config.preset,
      params: { ...this.config.params },
      devices,
      links,
      blocked,
      walls: [...this.medium.walls],
      packets: this.packets.map((packet) => ({
        id: packet.id,
        from: packet.from,
        to: packet.to,
        kind: packet.kind,
        start: packet.start,
        end: packet.end,
        failed: packet.failed,
      })),
      latest: this.latestSample(),
      samples,
      sampleCursor: this.metrics.samples.length,
      log,
      logCursor: this.logLines[this.logLines.length - 1]?.seq ?? logCursor,
      converged: this.metrics.converged,
      oversizePackets: this.metrics.oversizePackets,
    };
  }

  deviceDetail(id: string): DeviceDetail | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    const total = this.metrics.items.size;
    const authorLabel = (meshId: string) => {
      const deviceId = this.meshIndex.get(meshId);
      return deviceId ? this.labelOf(deviceId) : meshId;
    };
    const links = [...this.medium.links.values()]
      .filter((link) => link.a === id || link.b === id)
      .map((link) => {
        const peer = peerOf(link, id);
        return {
          peer,
          label: this.labelOf(peer),
          state: link.state,
          rssi: rssiAt(this.medium.distanceBetween(id, peer)),
          upSince: link.upSince,
          pinned: this.medium.pinned.has(link.key),
        };
      });
    const items = [...node.replica.items.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 400)
      .map((item) => {
        const arrival = node.replica.arrivals.get(item.tid)!;
        return {
          tid: item.tid,
          author: item.author,
          authorLabel: authorLabel(item.author),
          seq: this.metrics.keyOf(item.tid)?.split(":")[1] ?? "–",
          ticketId: item.ticketId,
          action: item.action,
          createdAt: item.createdAt,
          arrivedAt: arrival.at,
          via: arrival.via,
          channel: arrival.channel,
          conflict: this.metrics.conflictedTids.has(item.tid),
        };
      });
    const missingRecords = [...this.metrics.items.values()].filter(
      (record) => !node.replica.has(record.item.tid),
    );
    return {
      id: node.id,
      meshId: node.meshId,
      label: node.label,
      platform: node.platform,
      power: node.power,
      position: { ...node.position },
      clockSkewMs: node.clockSkewMs,
      maxLinks: node.maxLinks,
      peerCount: node.peerCount,
      links,
      writeQueue: node.transport.queuedJobs,
      router: node.routerInternals(),
      replica: {
        count: node.replica.size,
        coverage: total === 0 ? 1 : node.replica.size / total,
        duplicates: node.duplicateReceptions,
        digest: node.itemSync.items.digest(),
        versionVector: node.itemSync.items.versionVector(),
        items,
      },
      missing: missingRecords
        .slice(-60)
        .reverse()
        .map((record) => ({
          tid: record.item.tid,
          author: authorLabel(record.item.author),
          ticketId: record.item.ticketId,
          createdAt: record.createdAt,
          reasons: this.explainMissing(node, record.item.tid),
        })),
      missingTotal: missingRecords.length,
      explanations: [...node.explanations].reverse(),
      log: this.logLines.filter((line) => line.device === id).slice(-300),
    };
  }

  linkDetail(a: string, b: string): LinkDetail {
    const key = pairKey(a, b);
    const link = this.medium.links.get(key);
    const stats = this.medium.statsFor(key);
    const meters = this.medium.distanceBetween(a, b);
    const [first, second] = key.split("|") as [string, string];
    return {
      key,
      a: first,
      b: second,
      state: link?.state ?? "none",
      upSince: link?.upSince ?? null,
      pinned: this.medium.pinned.has(key),
      blocked: this.medium.blocked.has(key),
      meters,
      rssi: rssiAt(meters),
      writesOk: stats.writesOk,
      writesFailed: stats.writesFailed,
      bytes: stats.bytes,
      connections: stats.connections,
      latencyBuckets: [...stats.latencyBuckets],
    };
  }

  traceItem(tid: string): ItemTrace | null {
    const record = this.metrics.items.get(tid);
    if (!record) return null;
    const holders = [...record.holders.entries()]
      .filter(([device]) => this.nodes.get(device)?.replica.has(tid))
      .map(([device, arrival]) => ({ device, ...arrival }))
      .sort((left, right) => left.at - right.at);
    const holderIds = new Set(holders.map((holder) => holder.device));
    return {
      tid,
      item: record.item,
      authorDevice: record.authorDevice,
      createdAt: record.createdAt,
      holders,
      neverReached: [...this.nodes.keys()].filter((id) => !holderIds.has(id)),
    };
  }

  /** Why the engine thinks `node` lacks `tid`, most specific first. */
  explainMissing(node: SimNode, tid: string): string[] {
    const record = this.metrics.items.get(tid);
    if (!record) return [];
    const now = this.clock.now;
    const reasons: string[] = [];
    const path = this.metrics.pathState(node.id, tid);
    const seconds = (milliseconds: number) =>
      `${(milliseconds / 1000).toFixed(1)} s`;

    if (node.power !== "on") {
      reasons.push(
        node.power === "appKilled"
          ? "The app is killed: no router, nothing arrives."
          : "Bluetooth is off: no links, nothing arrives.",
      );
    }
    const wasOffDuringFlood = node.powerHistory.some(
      (span) =>
        span.power !== "on" &&
        span.from <= record.lastArrivalAt &&
        (span.to ?? now) >= record.createdAt,
    );
    if (wasOffDuringFlood) {
      reasons.push(
        "This device was off (Bluetooth off or app killed) while the item flooded.",
      );
    }
    if (!path || path.firstPathAt === null) {
      reasons.push(
        "No path to any holder since it was created (partition, walls or range).",
      );
      return reasons;
    }
    if (this.metrics.failedDeliveries.get(node.id)?.has(tid)) {
      reasons.push(
        "A write carrying it to this device failed (write loss or a link drop mid-write).",
      );
    }
    // Sampling is per second: only claim "flooded before the path" with a clear gap.
    if (path.firstPathAt - record.lastArrivalAt > SAMPLE_INTERVAL_MS) {
      reasons.push(
        `Its flood ended at ${seconds(record.lastArrivalAt)}, before this device first had a path to a holder (${seconds(path.firstPathAt)}).${this.config.sync.repair === false ? " With repair off, nothing re-sends it." : ""}`,
      );
    }
    if (path.since !== null && now - path.since < LOST_GRACE_MS) {
      reasons.push(
        `A path to a holder exists for ${seconds(now - path.since)}: it may still arrive (${LOST_GRACE_MS / 1000} s grace).`,
      );
    } else if (path.since !== null) {
      reasons.push(
        `Lost by protocol: a path to a holder has existed for ${seconds(now - path.since)} and it has not arrived.`,
      );
    }
    if (reasons.length === 0) {
      reasons.push(
        "Neighbours holding it never relayed it here (TTL exhausted or a router queue dropped it), and repair has not fetched it yet.",
      );
    }
    return reasons;
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  private isActionDue(action: Action, target: number): boolean {
    if (action.event !== undefined) {
      return this.clock.fired >= action.event && action.at <= target;
    }
    if (action.at > target) return false;
    const nextTimer = this.clock.nextTimerAt();
    // Timers at the action's own instant run first, like a live action taken after a tick.
    return nextTimer === null || nextTimer > action.at;
  }

  private async applyNextDueAction(target: number): Promise<boolean> {
    const next = this.pending[0];
    if (!next || !this.isActionDue(next, target)) return false;
    this.pending.shift();
    // Same settling as a live action gets (it runs after `advanceTo` drained and returned).
    await drainMicrotasks(SETTLE_DRAIN_TURNS);
    this.clock.setNow(next.at);
    await this.apply(next);
    await drainMicrotasks(SETTLE_DRAIN_TURNS);
    return true;
  }

  private async drainDueActions(target: number): Promise<void> {
    while (await this.applyNextDueAction(target)) {
      // Keep applying.
    }
  }

  private async apply(action: Action): Promise<void> {
    this.actions.push(action);
    this.metrics.disturb(this.clock.now);
    this.event(null, "action", `Action: ${action.do}`, {
      ...action,
      at: undefined,
      event: undefined,
    });
    try {
      await this.applyBody(action);
    } catch (error) {
      this.event(
        null,
        "action",
        `Action ${action.do} failed: ${errorMessage(error)}`,
        undefined,
        "error",
      );
    }
  }

  private async applyBody(action: ActionBody): Promise<void> {
    switch (action.do) {
      case "addDevice": {
        if (this.nodes.has(action.device.id))
          throw new Error(`Device ${action.device.id} exists`);
        const node = this.createNode(action.device);
        await node.setPower(action.device.power ?? "on");
        return;
      }
      case "removeDevice": {
        const node = this.requireNode(action.device);
        await this.setPower(node, "appKilled");
        this.medium.forgetDevice(node.id);
        this.metrics.forgetHolder(node.id);
        this.clearScanTimer(node.id);
        this.nodes.delete(node.id);
        return;
      }
      case "moveDevice": {
        const node = this.requireNode(action.device);
        node.position = { ...action.position };
        this.medium.tick();
        return;
      }
      case "setPower":
        await this.setPower(this.requireNode(action.device), action.power);
        return;
      case "powerOff":
        await this.setPower(this.requireNode(action.device), "bluetoothOff");
        return;
      case "powerOn":
        await this.setPower(this.requireNode(action.device), "on");
        return;
      case "killApp":
        await this.setPower(this.requireNode(action.device), "appKilled");
        return;
      case "factoryReset": {
        const node = this.requireNode(action.device);
        const wasOn = node.power === "on";
        await this.setPower(node, "appKilled");
        node.resetIdentity(this.newMeshId());
        this.meshIndex.set(node.meshId, node.id);
        this.metrics.forgetHolder(node.id);
        if (wasOn) await this.setPower(node, "on");
        return;
      }
      case "blockLink":
        this.medium.setBlocked(action.a, action.b, true);
        return;
      case "unblockLink":
        this.medium.setBlocked(action.a, action.b, false);
        return;
      case "pinLink":
        this.medium.setPinned(action.a, action.b, true);
        return;
      case "unpinLink":
        this.medium.setPinned(action.a, action.b, false);
        return;
      case "addWall":
        this.medium.addWall({ ...action.wall });
        return;
      case "removeWall":
        this.medium.removeWall(action.id);
        return;
      case "setParams":
        Object.assign(this.config.params, action.params);
        return;
      case "setSync": {
        // Read live by every node's sync, like the `sync` prop of `MeshProvider`, which also
        // compares right away when repair turns on.
        const wasRepairing = resolveSyncOptions(this.config.sync).repair;
        Object.assign(this.config.sync, action.sync);
        if (!wasRepairing && resolveSyncOptions(this.config.sync).repair) {
          for (const node of this.nodes.values()) node.itemSync.compareNow();
        }
        return;
      }
      case "setScope":
        await this.requireNode(action.device).setScope(action.scope);
        return;
      case "scan":
        this.scanOnce(this.requireNode(action.device));
        return;
      case "burst": {
        const node = this.requireNode(action.device);
        for (let index = 0; index < action.count; index += 1)
          this.scanOnce(node);
        return;
      }
    }
  }

  private requireNode(id: string): SimNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown device "${id}"`);
    return node;
  }

  private async setPower(node: SimNode, power: PowerState): Promise<void> {
    if (node.power === power) return;
    const restore = this.churnRestore.get(node.id);
    if (restore !== undefined) {
      clearTimeout(restore);
      this.churnRestore.delete(node.id);
    }
    // Relaunching a killed app from Bluetooth-off still goes through a fresh process.
    if (power !== "on") {
      // Mark the node down before dropping links so peers see the disconnect and it does not.
      const wasOn = node.power === "on";
      await node.setPower(power);
      if (wasOn) this.medium.dropLinksOf(node.id, "power");
    } else {
      await node.setPower(power);
    }
    this.event(node.id, "power", `Power → ${power}`);
  }

  // ─── Nodes, links, generator, churn ───────────────────────────────────────

  private createNode(spec: DeviceSpec): SimNode {
    const node = new SimNode(this, spec, this.newMeshId());
    this.nodes.set(node.id, node);
    this.meshIndex.set(node.meshId, node.id);
    this.scheduleScan(node.id);
    return node;
  }

  private newMeshId(): string {
    let meshId = randomHex(this.random.ids, DEVICE_ID_BYTES);
    while (this.meshIndex.has(meshId)) {
      meshId = randomHex(this.random.ids, DEVICE_ID_BYTES);
    }
    return meshId;
  }

  private handleLinkUp(link: Link): void {
    this.event(link.a, "link", `Link up with ${this.labelOf(link.b)}`);
    this.nodes.get(link.a)?.onLinkUp(link.b);
    this.nodes.get(link.b)?.onLinkUp(link.a);
  }

  private handleLinkDown(link: Link, reason: LinkDownReason): void {
    this.event(
      link.a,
      "link",
      `Link down with ${this.labelOf(link.b)} (${reason})`,
    );
    this.nodes.get(link.a)?.onLinkDown(link.b);
    this.nodes.get(link.b)?.onLinkDown(link.a);
  }

  private scheduleScan(deviceId: string): void {
    const rate = this.config.params.scanRatePerMin;
    // While the generator is off, check back every second so a rate change takes effect.
    const delay =
      rate > 0 ? exponential(this.random.generator, 60_000 / rate) : 1_000;
    const timer = setTimeout(() => {
      this.scanTimers.delete(deviceId);
      const node = this.nodes.get(deviceId);
      if (!node) return;
      if (rate > 0 && this.config.params.scanRatePerMin > 0) {
        this.scanOnce(node);
      }
      this.scheduleScan(deviceId);
    }, delay) as unknown as number;
    this.scanTimers.set(deviceId, timer);
  }

  private clearScanTimer(deviceId: string): void {
    const timer = this.scanTimers.get(deviceId);
    if (timer !== undefined) clearTimeout(timer);
    this.scanTimers.delete(deviceId);
  }

  /**
   * One scan on a device. Draws the same random numbers whatever the outcome, so the stream (and
   * every later scan) stays aligned across sync settings.
   */
  private scanOnce(node: SimNode): void {
    const ticketId =
      1 + Math.floor(this.random.generator() * this.config.params.ticketPool);
    const roll = this.random.generator();
    // A killed app scans nothing; Bluetooth off does not stop staff from scanning offline.
    if (node.power === "appKilled") return;
    const { inside } = node.replica.ticketState(ticketId);
    if (!inside) {
      node.scan(ticketId, "scan");
    } else if (roll < CHECKOUT_PROBABILITY) {
      node.scan(ticketId, "checkout");
    } else {
      this.event(node.id, "item", `Refused re-entry of ticket #${ticketId}`);
    }
  }

  private rollDeviceChurn(): void {
    const { bluetoothTogglesPerHour, appKillsPerHour } = this.config.params;
    if (bluetoothTogglesPerHour <= 0 && appKillsPerHour <= 0) return;
    const toggleChance = (bluetoothTogglesPerHour * CHURN_TICK_MS) / 3_600_000;
    const killChance = (appKillsPerHour * CHURN_TICK_MS) / 3_600_000;
    for (const node of [...this.nodes.values()]) {
      const toggleRoll = this.random.medium();
      const killRoll = this.random.medium();
      const duration = this.random.medium();
      if (node.power !== "on" || this.churnRestore.has(node.id)) continue;
      let power: PowerState | null = null;
      let downMs = 0;
      if (killRoll < killChance) {
        power = "appKilled";
        downMs = APP_DEAD_MS[0] + duration * (APP_DEAD_MS[1] - APP_DEAD_MS[0]);
      } else if (toggleRoll < toggleChance) {
        power = "bluetoothOff";
        downMs =
          BLUETOOTH_OFF_MS[0] +
          duration * (BLUETOOTH_OFF_MS[1] - BLUETOOTH_OFF_MS[0]);
      }
      if (!power) continue;
      const nodeId = node.id;
      void this.setPower(node, power).then(() => {
        const timer = setTimeout(() => {
          this.churnRestore.delete(nodeId);
          const current = this.nodes.get(nodeId);
          if (current && current.power === power)
            void this.setPower(current, "on");
        }, downMs) as unknown as number;
        this.churnRestore.set(nodeId, timer);
      });
    }
  }

  // ─── Sampling, logs, packets ──────────────────────────────────────────────

  private takeSample(): void {
    const component = this.components();
    const views: DeviceView[] = [...this.nodes.values()].map((node) => ({
      id: node.id,
      powered: node.power === "on",
      linked: this.medium.readyLinksOf(node.id).length > 0,
      component: component.get(node.id) ?? -1,
      has: (tid) => node.replica.has(tid),
      heldCount: node.replica.size,
    }));
    this.metrics.setDuplicates(
      [...this.nodes.values()].reduce(
        (sum, node) => sum + node.duplicateReceptions,
        0,
      ),
    );
    const sample = this.metrics.sample(this.clock.now, views);
    this.maxLostByProtocol = Math.max(
      this.maxLostByProtocol,
      sample.lostByProtocol,
    );
    this.prunePackets();
  }

  /** Connected components over up links (powered devices only). */
  private components(): Map<string, number> {
    const component = new Map<string, number>();
    const neighbours = new Map<string, string[]>();
    for (const link of this.medium.links.values()) {
      if (link.state !== "up") continue;
      neighbours.set(link.a, [...(neighbours.get(link.a) ?? []), link.b]);
      neighbours.set(link.b, [...(neighbours.get(link.b) ?? []), link.a]);
    }
    let next = 0;
    for (const node of this.nodes.values()) {
      if (node.power !== "on" || component.has(node.id)) continue;
      const id = next++;
      const queue = [node.id];
      component.set(node.id, id);
      while (queue.length > 0) {
        const current = queue.pop()!;
        for (const neighbour of neighbours.get(current) ?? []) {
          if (!component.has(neighbour)) {
            component.set(neighbour, id);
            queue.push(neighbour);
          }
        }
      }
    }
    return component;
  }

  private prunePackets(): void {
    const cutoff = this.clock.now - PACKET_LINGER_MS;
    if (this.packets.length > 0 && this.packets[0]!.end < cutoff) {
      this.packets = this.packets.filter((packet) => packet.end >= cutoff);
    }
  }

  /** An engine event: always hashed, always logged. */
  private event(
    deviceId: string | null,
    tag: string,
    message: string,
    detail?: Record<string, unknown>,
    level: LogLevel = "info",
  ): void {
    this.pushLog(deviceId, tag, message, detail, level, "engine");
  }

  private pushLog(
    deviceId: string | null,
    tag: string,
    message: string,
    detail: Record<string, unknown> | undefined,
    level: LogLevel,
    source: "engine" | "router" = "router",
  ): void {
    const detailText = detail ? JSON.stringify(detail) : undefined;
    const line: LogLine = {
      seq: this.nextLogSeq++,
      t: this.clock.now,
      device: deviceId,
      source,
      tag,
      level,
      message,
      detail: detailText,
    };
    this.hashText(
      `${line.t} ${deviceId} ${tag} ${level} ${message} ${detailText ?? ""}`,
    );
    this.logLines.push(line);
    if (this.logLines.length > this.maxLogLines * 1.2) {
      this.logLines.splice(0, this.logLines.length - this.maxLogLines);
    }
  }

  private hashText(text: string): void {
    this.hash = fnv1a(text, this.hash);
  }
}
