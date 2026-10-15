import { exponential, uniform, type Rng } from "./random";
import type { NetworkParams, Point, PowerState, Wall } from "./types";

/** How often the medium re-evaluates ranges, walls and churn. */
export const MEDIUM_TICK_MS = 250;

/** What the medium needs to know about a device. */
export type MediumDevice = {
  readonly id: string;
  readonly position: Point;
  readonly power: PowerState;
  readonly maxLinks: number;
};

export type LinkState = "discovering" | "connecting" | "up";

export type Link = {
  key: string;
  a: string;
  b: string;
  state: LinkState;
  createdAt: number;
  upSince: number | null;
  /** Bumped on every new connection, so a write knows whether its link survived. */
  epoch: number;
};

/** Per device pair, kept across reconnects. */
export type PairStats = {
  writesOk: number;
  writesFailed: number;
  bytes: number;
  /** Write latency histogram, 5 ms buckets up to 200 ms (last bucket is overflow). */
  latencyBuckets: number[];
  lastFailAt: number | null;
  /** Exponentially decaying bytes per second, for link thickness. */
  traffic: number;
  trafficAt: number;
  connections: number;
};

export type LinkDownReason =
  "power" | "range" | "wall" | "blocked" | "churn" | "removed";

export type MediumHooks = {
  onLinkUp: (link: Link) => void;
  onLinkDown: (link: Link, reason: LinkDownReason) => void;
};

export const LATENCY_BUCKET_MS = 5;
export const LATENCY_BUCKET_COUNT = 41;
const TRAFFIC_HALF_LIFE_MS = 1_000;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Log-distance path loss: -59 dBm at 1 m, exponent 2.2. */
export function rssiAt(meters: number): number {
  return Math.round(-59 - 22 * Math.log10(Math.max(meters, 0.5)));
}

function orientation(p: Point, q: Point, r: Point): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

export function segmentsCross(
  p1: Point,
  p2: Point,
  q1: Point,
  q2: Point,
): boolean {
  const d1 = orientation(q1, q2, p1);
  const d2 = orientation(q1, q2, p2);
  const d3 = orientation(p1, p2, q1);
  const d4 = orientation(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * The simulated radio: which devices see each other, which GATT links exist, and how links
 * come and go. Writes themselves live in `SimTransport`.
 */
export class Medium {
  readonly links = new Map<string, Link>();
  readonly pairStats = new Map<string, PairStats>();
  readonly blocked = new Set<string>();
  readonly pinned = new Set<string>();
  readonly walls: Wall[] = [];
  private nextEpoch = 1;
  private tickTimer: number | null = null;

  constructor(
    public params: NetworkParams,
    private readonly now: () => number,
    private readonly rng: Rng,
    private readonly devices: () => Iterable<MediumDevice>,
    private readonly device: (id: string) => MediumDevice | undefined,
    private readonly hooks: MediumHooks,
  ) {}

  start(): void {
    this.tickTimer = setInterval(
      () => this.tick(),
      MEDIUM_TICK_MS,
    ) as unknown as number;
  }

  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  linkBetween(a: string, b: string): Link | undefined {
    return this.links.get(pairKey(a, b));
  }

  /** Links in state `up` for a device, ordered by peer ID. */
  readyLinksOf(deviceId: string): Link[] {
    const ready: Link[] = [];
    for (const link of this.links.values()) {
      if (link.state === "up" && (link.a === deviceId || link.b === deviceId)) {
        ready.push(link);
      }
    }
    ready.sort((left, right) =>
      peerOf(left, deviceId) < peerOf(right, deviceId) ? -1 : 1,
    );
    return ready;
  }

  linkCountOf(deviceId: string): number {
    let count = 0;
    for (const link of this.links.values()) {
      if (link.a === deviceId || link.b === deviceId) {
        count += 1;
      }
    }
    return count;
  }

  statsFor(key: string): PairStats {
    let stats = this.pairStats.get(key);
    if (!stats) {
      stats = {
        writesOk: 0,
        writesFailed: 0,
        bytes: 0,
        latencyBuckets: new Array<number>(LATENCY_BUCKET_COUNT).fill(0),
        lastFailAt: null,
        traffic: 0,
        trafficAt: 0,
        connections: 0,
      };
      this.pairStats.set(key, stats);
    }
    return stats;
  }

  recordWrite(
    key: string,
    ok: boolean,
    bytes: number,
    latencyMs: number,
    at: number,
  ): void {
    const stats = this.statsFor(key);
    if (ok) {
      stats.writesOk += 1;
      stats.bytes += bytes;
      stats.traffic = this.decayedTraffic(stats, at) + bytes;
      stats.trafficAt = at;
      const bucket = Math.min(
        LATENCY_BUCKET_COUNT - 1,
        Math.floor(latencyMs / LATENCY_BUCKET_MS),
      );
      stats.latencyBuckets[bucket]! += 1;
    } else {
      stats.writesFailed += 1;
      stats.lastFailAt = at;
    }
  }

  /** Recent bytes on a pair, decaying with a one-second half-life. */
  trafficOf(key: string, at: number): number {
    const stats = this.pairStats.get(key);
    return stats ? this.decayedTraffic(stats, at) : 0;
  }

  distanceBetween(a: string, b: string): number {
    const deviceA = this.device(a);
    const deviceB = this.device(b);
    if (!deviceA || !deviceB) {
      return Infinity;
    }
    return distance(deviceA.position, deviceB.position);
  }

  isBlockedByWall(a: Point, b: Point): boolean {
    return this.walls.some((wall) => segmentsCross(a, b, wall.a, wall.b));
  }

  setBlocked(a: string, b: string, blocked: boolean): void {
    const key = pairKey(a, b);
    if (blocked) {
      this.blocked.add(key);
      this.pinned.delete(key);
      this.dropLink(key, "blocked");
    } else {
      this.blocked.delete(key);
    }
  }

  setPinned(a: string, b: string, pinned: boolean): void {
    const key = pairKey(a, b);
    if (pinned) {
      this.pinned.add(key);
      this.blocked.delete(key);
    } else {
      this.pinned.delete(key);
    }
  }

  addWall(wall: Wall): void {
    this.walls.push(wall);
    this.dropInvalidLinks();
  }

  removeWall(id: string): void {
    const index = this.walls.findIndex((wall) => wall.id === id);
    if (index >= 0) {
      this.walls.splice(index, 1);
    }
  }

  /** Drops every link of a device (it lost power, was removed, or its app died). */
  dropLinksOf(deviceId: string, reason: LinkDownReason): void {
    for (const link of [...this.links.values()]) {
      if (link.a === deviceId || link.b === deviceId) {
        this.dropLink(link.key, reason);
      }
    }
  }

  forgetDevice(deviceId: string): void {
    this.dropLinksOf(deviceId, "removed");
    for (const key of [...this.blocked]) {
      if (key.split("|").includes(deviceId)) this.blocked.delete(key);
    }
    for (const key of [...this.pinned]) {
      if (key.split("|").includes(deviceId)) this.pinned.delete(key);
    }
  }

  /** Re-evaluates every link and looks for new neighbours. */
  tick(): void {
    this.dropInvalidLinks();
    this.churn();
    this.discover();
  }

  private decayedTraffic(stats: PairStats, at: number): number {
    const elapsed = Math.max(0, at - stats.trafficAt);
    return stats.traffic * Math.pow(0.5, elapsed / TRAFFIC_HALF_LIFE_MS);
  }

  private invalidReason(link: Link): LinkDownReason | null {
    const deviceA = this.device(link.a);
    const deviceB = this.device(link.b);
    if (!deviceA || !deviceB) {
      return "removed";
    }
    if (deviceA.power !== "on" || deviceB.power !== "on") {
      return "power";
    }
    if (this.blocked.has(link.key)) {
      return "blocked";
    }
    if (this.pinned.has(link.key)) {
      return null;
    }
    if (distance(deviceA.position, deviceB.position) > this.params.range) {
      return "range";
    }
    if (this.isBlockedByWall(deviceA.position, deviceB.position)) {
      return "wall";
    }
    return null;
  }

  private dropInvalidLinks(): void {
    for (const link of [...this.links.values()]) {
      const reason = this.invalidReason(link);
      if (reason) {
        this.dropLink(link.key, reason);
      }
    }
  }

  private churn(): void {
    const mtbf = this.params.linkMtbfMs;
    if (mtbf === null || mtbf <= 0) {
      return;
    }
    const dropProbability = 1 - Math.exp(-MEDIUM_TICK_MS / mtbf);
    for (const link of [...this.links.values()]) {
      if (link.state !== "up" || this.pinned.has(link.key)) {
        continue;
      }
      if (this.rng() < dropProbability) {
        this.dropLink(link.key, "churn");
      }
    }
  }

  private discover(): void {
    const powered = [...this.devices()].filter(
      (device) => device.power === "on",
    );
    const candidates: { a: MediumDevice; b: MediumDevice; meters: number }[] =
      [];
    for (let i = 0; i < powered.length; i += 1) {
      for (let j = i + 1; j < powered.length; j += 1) {
        const a = powered[i]!;
        const b = powered[j]!;
        const key = pairKey(a.id, b.id);
        if (this.links.has(key) || this.blocked.has(key)) {
          continue;
        }
        const meters = distance(a.position, b.position);
        const inReach =
          this.pinned.has(key) ||
          (meters <= this.params.range &&
            !this.isBlockedByWall(a.position, b.position));
        if (inReach) {
          candidates.push({ a, b, meters });
        }
      }
    }

    // Strongest signal first, like a scanner that connects to the loudest advertiser.
    candidates.sort((left, right) => left.meters - right.meters);
    for (const { a, b } of candidates) {
      if (
        this.linkCountOf(a.id) >= a.maxLinks ||
        this.linkCountOf(b.id) >= b.maxLinks
      ) {
        continue;
      }
      this.beginLink(a.id, b.id);
    }
  }

  private beginLink(a: string, b: string): void {
    const [first, second] = a < b ? [a, b] : [b, a];
    const link: Link = {
      key: pairKey(a, b),
      a: first,
      b: second,
      state: "discovering",
      createdAt: this.now(),
      upSince: null,
      epoch: 0,
    };
    this.links.set(link.key, link);

    const [discoverMin, discoverMax] = this.params.discoveryDelayMs;
    const [connectMin, connectMax] = this.params.connectDelayMs;
    const discoveryDelay = uniform(this.rng, discoverMin, discoverMax);
    const connectDelay = uniform(this.rng, connectMin, connectMax);

    setTimeout(() => {
      if (this.links.get(link.key) !== link) {
        return;
      }
      link.state = "connecting";
      setTimeout(() => {
        if (this.links.get(link.key) !== link || this.invalidReason(link)) {
          return;
        }
        link.state = "up";
        link.upSince = this.now();
        link.epoch = this.nextEpoch++;
        this.statsFor(link.key).connections += 1;
        this.hooks.onLinkUp(link);
      }, connectDelay);
    }, discoveryDelay);
  }

  private dropLink(key: string, reason: LinkDownReason): void {
    const link = this.links.get(key);
    if (!link) {
      return;
    }
    this.links.delete(key);
    if (link.state === "up") {
      this.hooks.onLinkDown(link, reason);
    }
  }
}

export function peerOf(link: Link, deviceId: string): string {
  return link.a === deviceId ? link.b : link.a;
}

/** Mean time to the next device-level churn event, or null when disabled. */
export function churnDelay(rng: Rng, perHour: number): number | null {
  if (perHour <= 0) {
    return null;
  }
  return exponential(rng, 3_600_000 / perHour);
}
