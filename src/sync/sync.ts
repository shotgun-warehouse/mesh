import { ITEM_PART_BYTES } from "../mesh/constants";
import type { MeshLogger } from "../mesh/logger";
import {
  buildSyncPacket,
  fitsOneWrite,
  type MeshItemPart,
  type MeshSessionPacket,
  type SyncRange,
} from "../mesh/packets";
import type { MeshItemStore } from "./store";
import type { MeshItem, MeshVersionVector } from "./types";

/**
 * Knobs for the sync layer, read live: a change applies from the next beacon or request, with no
 * restart. Defaults come from the simulator's bench (`simulator/`).
 */
export type MeshSyncOptions = {
  /**
   * Compare with neighbours and fetch what is missing. Off, each item is flooded once when it is
   * published and devices that were not reachable then never get it. Default true.
   */
  repair?: boolean;
  /** Digest beacon interval right after a change (Trickle minimum), in ms. Default 1000. */
  minDigestIntervalMs?: number;
  /** Digest beacon interval once neighbours agree (Trickle maximum), in ms. Default 16000. */
  maxDigestIntervalMs?: number;
  /** Items asked from one neighbour per round; the next round starts when it lands. Default 40. */
  maxItemsPerRequest?: number;
  /** Hops a freshly published item floods. Default 7. */
  pushHops?: number;
};

export type ResolvedMeshSyncOptions = Required<MeshSyncOptions>;

export const DEFAULT_SYNC_OPTIONS: ResolvedMeshSyncOptions = {
  repair: true,
  minDigestIntervalMs: 1_000,
  maxDigestIntervalMs: 16_000,
  maxItemsPerRequest: 40,
  pushHops: 7,
};

export function resolveSyncOptions(
  options: MeshSyncOptions | undefined,
): ResolvedMeshSyncOptions {
  const resolved = { ...DEFAULT_SYNC_OPTIONS };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  resolved.minDigestIntervalMs = Math.max(100, resolved.minDigestIntervalMs);
  resolved.maxDigestIntervalMs = Math.max(
    resolved.minDigestIntervalMs,
    resolved.maxDigestIntervalMs,
  );
  resolved.maxItemsPerRequest = Math.max(
    1,
    Math.floor(resolved.maxItemsPerRequest),
  );
  resolved.pushHops = Math.max(0, Math.min(255, Math.floor(resolved.pushHops)));
  return resolved;
}

/** One version-vector exchange, for diagnostics (the simulator's sync explainer). */
export type MeshSyncExchange = {
  at: number;
  peer: string;
  mine: MeshVersionVector;
  theirs: MeshVersionVector;
  /** Ranges this device asked the peer for. */
  requested: SyncRange[];
};

/** What sync needs from the router. */
export type MeshSyncLink = {
  readonly localDeviceId: string;
  /** Floods a packet (`ttl` > 0) or writes it to neighbours (`ttl` 0), only `targetDeviceId` if set. */
  sendSyncPacket(
    packet: MeshSessionPacket,
    targetDeviceId: string | null,
  ): Promise<void>;
};

/** How new items reached this device (diagnostics). */
export type MeshItemArrival = {
  /** Link the packet arrived on (a BLE link ID on phones, the mesh ID in the simulator). */
  linkDeviceId: string | null;
  /** `flood` for a fresh item's push, `repair` for an answer to this device's request. */
  channel: "flood" | "repair";
};

export type MeshSyncCallbacks = {
  /** Items this device did not have, from a flood or from a neighbour. Already in the store. */
  onItems: (items: MeshItem[], arrival: MeshItemArrival) => void;
  onExchange?: (exchange: MeshSyncExchange) => void;
};

/** Consecutive differing digests from a neighbour before vectors are exchanged. */
const MISMATCHES_BEFORE_VECTOR = 2;
/** Digests heard per interval that suppress this device's own beacon (Trickle k). */
const TRICKLE_REDUNDANCY = 1;
/** A version vector goes to one neighbour at most this often. */
const VECTOR_COOLDOWN_MS = 1_000;
/**
 * A range asked from one neighbour is not asked from another until that neighbour has sent
 * nothing for this long (answers are long when items are large or the radio is busy).
 */
const REQUEST_CLAIM_MS = 3_000;
/** A request round is over when nothing arrived from the neighbour for this long (lost writes). */
const ROUND_IDLE_MS = 1_500;
const MAX_VECTOR_ENTRIES_PER_PACKET = 55;
const MAX_RANGES_PER_PACKET = 35;
/** An item partly received this recently is not requested: the rest of its flood is coming. */
const ARRIVING_ITEM_GRACE_MS = 5_000;
/** Parts of an item that stopped arriving are dropped after this long (repair fetches it again). */
const PART_ASSEMBLY_TIMEOUT_MS = 60_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Splits an item's data into parts that each fit one packet. */
export function splitItem(item: MeshItem): MeshItemPart[] {
  const bytes = textEncoder.encode(item.data);
  const partCount = Math.max(1, Math.ceil(bytes.length / ITEM_PART_BYTES));
  return Array.from({ length: partCount }, (_, partIndex) => ({
    author: item.author,
    seq: item.seq,
    createdAt: item.createdAt,
    partIndex,
    partCount,
    bytes: bytes.slice(
      partIndex * ITEM_PART_BYTES,
      (partIndex + 1) * ITEM_PART_BYTES,
    ),
  }));
}

type PartAssembly = {
  createdAt: number;
  partCount: number;
  chunks: Map<number, Uint8Array>;
  startedAt: number;
};

/** Reassembles items from parts, which arrive in any order and from any neighbour. */
class PartAssembler {
  private readonly pending = new Map<string, PartAssembly>();

  /** Returns the item once its last part arrives. */
  add(part: MeshItemPart): MeshItem | null {
    if (part.partCount === 1) {
      return {
        author: part.author,
        seq: part.seq,
        createdAt: part.createdAt,
        data: textDecoder.decode(part.bytes),
      };
    }
    this.prune();
    const key = `${part.author}:${part.seq}`;
    let assembly = this.pending.get(key);
    if (!assembly || assembly.partCount !== part.partCount) {
      assembly = {
        createdAt: part.createdAt,
        partCount: part.partCount,
        chunks: new Map(),
        startedAt: Date.now(),
      };
      this.pending.set(key, assembly);
    }
    assembly.chunks.set(part.partIndex, part.bytes);
    if (assembly.chunks.size < assembly.partCount) {
      return null;
    }
    this.pending.delete(key);
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < assembly.partCount; index += 1) {
      chunks.push(assembly.chunks.get(index)!);
    }
    const merged = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      author: part.author,
      seq: part.seq,
      createdAt: assembly.createdAt,
      data: textDecoder.decode(merged),
    };
  }

  /** Some parts of this item arrived recently: its flood is still coming. */
  isArriving(author: string, seq: number): boolean {
    const assembly = this.pending.get(`${author}:${seq}`);
    return (
      assembly !== undefined &&
      Date.now() - assembly.startedAt < ARRIVING_ITEM_GRACE_MS
    );
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, assembly] of this.pending) {
      if (now - assembly.startedAt > PART_ASSEMBLY_TIMEOUT_MS) {
        this.pending.delete(key);
      }
    }
  }
}

type Neighbour = {
  /** Consecutive digests from this neighbour that differed from ours. */
  mismatches: number;
  lastVectorSentAt: number;
  /** The neighbour's latest version vector, to continue a catch-up without asking again. */
  theirs: MeshVersionVector | null;
  /** Items still expected from the current request round. */
  awaiting: number;
  roundTimer: ReturnType<typeof setTimeout> | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the item set in sync with the mesh, for one mesh session (it stops with the router; the
 * store outlives it).
 *
 * - **Push.** A published item floods the mesh once (in parts when it is larger
 *   than one packet).
 * - **Repair (anti-entropy).** Each device beacons a digest of its set to its neighbours on a
 *   Trickle timer: often after a change, rarely once they agree. Two differing digests in a row
 *   from a neighbour start an exchange of version vectors (`{author: highest contiguous seq}`)
 *   and each side asks for the `(author, from…to)` ranges it misses. Requests and answers stay
 *   on the one link (never relayed). A link coming up starts an exchange right away.
 */
export class MeshSync {
  private active = false;
  private intervalMs = DEFAULT_SYNC_OPTIONS.minDigestIntervalMs;
  private heardConsistent = 0;
  private beaconTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly neighbours = new Map<string, Neighbour>();
  /** Per author, the highest seq already asked for, from whom and when. */
  private readonly claims = new Map<
    string,
    { seq: number; at: number; peer: string }
  >();
  private readonly assembler = new PartAssembler();
  /**
   * Per neighbour, the parts of its latest request not sent yet. A new request replaces them:
   * the neighbour asks again for everything it still lacks, so older answers are stale.
   */
  private readonly answers = new Map<string, { parts: MeshItemPart[] }>();

  /**
   * @param scope Hash of the sync scope (`scopeHash`): sync packets of other scopes are ignored,
   *   so devices on different events never mix their sets.
   */
  constructor(
    private readonly scope: number,
    private readonly store: MeshItemStore,
    private readonly link: MeshSyncLink,
    private readonly options: () => ResolvedMeshSyncOptions,
    private readonly callbacks: MeshSyncCallbacks,
    private readonly log: MeshLogger,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.intervalMs = this.options().minDigestIntervalMs;
    this.beginInterval();
  }

  stop(): void {
    this.active = false;
    this.clearTimer("beaconTimer");
    this.clearTimer("intervalTimer");
    for (const neighbour of this.neighbours.values()) {
      if (neighbour.roundTimer !== null) clearTimeout(neighbour.roundTimer);
    }
    this.neighbours.clear();
    this.answers.clear();
  }

  /** Floods a freshly published item (one packet per part). */
  push(item: MeshItem): void {
    if (!this.active) return;
    for (const part of splitItem(item)) {
      this.send(
        buildSyncPacket(
          this.link.localDeviceId,
          "syncItems",
          this.scope,
          { parts: [part] },
          this.options().pushHops,
          null,
        ),
        null,
        "Item push",
      );
    }
  }

  /** A link to `deviceId` came up: compare right away. */
  neighbourUp(deviceId: string): void {
    if (!this.active) return;
    const neighbour = this.neighbour(deviceId);
    this.resetTrickle();
    if (this.options().repair) {
      this.sendVector(deviceId, neighbour);
    }
  }

  /**
   * Something changed that makes a gap likely (repair turned on, items seeded): beacon soon and,
   * with repair on, send this device's vector to every neighbour now rather than wait for two
   * differing digests.
   */
  compareNow(): void {
    if (!this.active) return;
    this.resetTrickle();
    if (!this.options().repair) return;
    for (const [deviceId, neighbour] of this.neighbours) {
      this.sendVector(deviceId, neighbour);
    }
  }

  neighbourDown(deviceId: string): void {
    const neighbour = this.neighbours.get(deviceId);
    if (neighbour?.roundTimer) clearTimeout(neighbour.roundTimer);
    this.neighbours.delete(deviceId);
    this.answers.delete(deviceId);
  }

  /** A sync packet addressed to this device (or to every neighbour). */
  handlePacket(
    packet: MeshSessionPacket,
    linkDeviceId: string | null = null,
  ): void {
    if (!this.active || packet.scope !== this.scope) return;
    const fromNeighbour = packet.ttl === 0 ? packet.senderId : null;

    if (packet.packetType === "syncItems") {
      const completed: MeshItem[] = [];
      for (const part of packet.parts ?? []) {
        if (this.store.has(part.author, part.seq)) {
          if (part.partIndex === 0) this.store.duplicates += 1;
          continue;
        }
        const item = this.assembler.add(part);
        if (item) completed.push(item);
      }
      const added = this.store.add(completed);
      if (added.length > 0) {
        this.callbacks.onItems(added, {
          linkDeviceId,
          channel: fromNeighbour ? "repair" : "flood",
        });
      }
      if (fromNeighbour) {
        this.continueCatchUp(fromNeighbour, completed.length);
      }
      return;
    }

    if (!fromNeighbour || !this.options().repair) return;
    const neighbour = this.neighbour(fromNeighbour);

    switch (packet.packetType) {
      case "syncDigest":
        if (packet.digest) {
          this.handleDigest(fromNeighbour, neighbour, packet.digest);
        }
        return;
      case "syncVector":
        this.handleVector(fromNeighbour, neighbour, packet.vector ?? []);
        return;
      case "syncRequest":
        this.handleRequest(fromNeighbour, packet.ranges ?? []);
        return;
    }
  }

  private neighbour(deviceId: string): Neighbour {
    let neighbour = this.neighbours.get(deviceId);
    if (!neighbour) {
      neighbour = {
        mismatches: 0,
        lastVectorSentAt: -Infinity,
        theirs: null,
        awaiting: 0,
        roundTimer: null,
      };
      this.neighbours.set(deviceId, neighbour);
    }
    return neighbour;
  }

  private handleDigest(
    deviceId: string,
    neighbour: Neighbour,
    digest: { xor: number; count: number },
  ): void {
    const mine = this.store.digest();
    if (mine.xor === digest.xor && mine.count === digest.count) {
      this.heardConsistent += 1;
      neighbour.mismatches = 0;
      return;
    }
    // One differing digest is usually a push still in flight; two in a row is a real gap.
    neighbour.mismatches += 1;
    this.resetTrickle();
    if (neighbour.mismatches >= MISMATCHES_BEFORE_VECTOR) {
      neighbour.mismatches = 0;
      this.sendVector(deviceId, neighbour);
    }
  }

  private handleVector(
    deviceId: string,
    neighbour: Neighbour,
    entries: [string, number][],
  ): void {
    // Vectors arrive in chunks: merge them into what this neighbour told us before.
    const theirs: MeshVersionVector = { ...(neighbour.theirs ?? {}) };
    for (const [author, seq] of entries) {
      theirs[author] = Math.max(theirs[author] ?? 0, seq);
    }
    neighbour.theirs = theirs;

    // Peers know more of this device's own items than it does (its store was wiped): never
    // reuse those seqs.
    const ownSeq = theirs[this.link.localDeviceId];
    if (ownSeq !== undefined) {
      this.store.reserveSeq(this.link.localDeviceId, ownSeq);
    }

    const mine = this.store.versionVector();
    this.requestMissing(deviceId, neighbour, theirs, mine, true);

    // The neighbour may lack authors it has never heard of: answer with our vector.
    const neighbourIsBehind = Object.entries(mine).some(
      ([author, seq]) => seq > (theirs[author] ?? 0),
    );
    if (neighbourIsBehind) {
      this.sendVector(deviceId, neighbour);
    }
  }

  private handleRequest(deviceId: string, ranges: SyncRange[]): void {
    const parts = ranges.flatMap(([author, fromSeq, toSeq]) =>
      this.store.range(author, fromSeq, toSeq).flatMap(splitItem),
    );
    const pending = this.answers.get(deviceId);
    if (pending) {
      pending.parts = parts;
      return;
    }
    const answer = { parts };
    this.answers.set(deviceId, answer);
    void this.pumpAnswer(deviceId, answer);
  }

  /** Sends an answer one packet at a time (each waits for its writes), packing parts that fit. */
  private async pumpAnswer(
    deviceId: string,
    answer: { parts: MeshItemPart[] },
  ): Promise<void> {
    try {
      while (
        this.active &&
        this.answers.get(deviceId) === answer &&
        answer.parts.length > 0
      ) {
        let count = 1;
        while (count < answer.parts.length && count < 255) {
          const packet = buildSyncPacket(
            this.link.localDeviceId,
            "syncItems",
            this.scope,
            { parts: answer.parts.slice(0, count + 1) },
            0,
            deviceId,
          );
          if (!fitsOneWrite(packet)) break;
          count += 1;
        }
        const batch = answer.parts.splice(0, count);
        await this.sendToNeighbourAsync(deviceId, "syncItems", {
          parts: batch,
        });
      }
    } finally {
      if (this.answers.get(deviceId) === answer) {
        this.answers.delete(deviceId);
      }
    }
  }

  /** The current batch from a neighbour landed (or stopped arriving): ask for the next one. */
  private continueCatchUp(deviceId: string, received: number): void {
    const neighbour = this.neighbours.get(deviceId);
    if (!neighbour || neighbour.awaiting <= 0) return;
    neighbour.awaiting = Math.max(0, neighbour.awaiting - received);
    // The answer is still coming: keep what we asked this neighbour claimed.
    const now = Date.now();
    for (const claim of this.claims.values()) {
      if (claim.peer === deviceId) claim.at = now;
    }
    if (neighbour.roundTimer !== null) clearTimeout(neighbour.roundTimer);
    neighbour.roundTimer = null;
    if (neighbour.awaiting === 0) {
      this.nextRound(deviceId, neighbour);
      return;
    }
    neighbour.roundTimer = setTimeout(() => {
      neighbour.roundTimer = null;
      this.nextRound(deviceId, neighbour);
    }, ROUND_IDLE_MS);
  }

  private nextRound(deviceId: string, neighbour: Neighbour): void {
    neighbour.awaiting = 0;
    if (
      this.active &&
      neighbour.theirs &&
      this.neighbours.get(deviceId) === neighbour
    ) {
      this.requestMissing(
        deviceId,
        neighbour,
        neighbour.theirs,
        this.store.versionVector(),
        false,
      );
    }
  }

  private requestMissing(
    deviceId: string,
    neighbour: Neighbour,
    theirs: MeshVersionVector,
    mine: MeshVersionVector,
    reportEmpty: boolean,
  ): void {
    const now = Date.now();
    const requested: SyncRange[] = [];
    let budget = this.options().maxItemsPerRequest;
    let requestedCount = 0;
    for (const author of Object.keys(theirs).sort()) {
      if (budget <= 0) break;
      const want = theirs[author]!;
      const claim = this.claims.get(author);
      const claimed =
        claim && claim.peer !== deviceId && now - claim.at < REQUEST_CLAIM_MS
          ? claim.seq
          : 0;
      // Past the contiguous prefix, items seeded from a server leave gaps: ask only for the
      // seqs not held (nor arriving), grouped into ranges.
      let rangeStart = 0;
      let highest = 0;
      for (
        let seq = Math.max(mine[author] ?? 0, claimed) + 1;
        seq <= want && budget > 0;
        seq += 1
      ) {
        if (
          this.store.has(author, seq) ||
          this.assembler.isArriving(author, seq)
        ) {
          if (rangeStart > 0) requested.push([author, rangeStart, highest]);
          rangeStart = 0;
          continue;
        }
        if (rangeStart === 0) rangeStart = seq;
        highest = seq;
        budget -= 1;
        requestedCount += 1;
      }
      if (rangeStart > 0) requested.push([author, rangeStart, highest]);
      if (highest > 0) {
        this.claims.set(author, { seq: highest, at: now, peer: deviceId });
      }
    }

    if (reportEmpty || requested.length > 0) {
      this.callbacks.onExchange?.({
        at: now,
        peer: deviceId,
        mine,
        theirs,
        requested,
      });
    }
    neighbour.awaiting = requestedCount;
    for (
      let index = 0;
      index < requested.length;
      index += MAX_RANGES_PER_PACKET
    ) {
      this.sendToNeighbour(deviceId, "syncRequest", {
        ranges: requested.slice(index, index + MAX_RANGES_PER_PACKET),
      });
    }
  }

  private sendVector(deviceId: string, neighbour: Neighbour): void {
    const now = Date.now();
    if (now - neighbour.lastVectorSentAt < VECTOR_COOLDOWN_MS) return;
    neighbour.lastVectorSentAt = now;
    const entries = Object.entries(this.store.versionVector());
    if (entries.length === 0) {
      this.sendToNeighbour(deviceId, "syncVector", { vector: [] });
      return;
    }
    for (
      let index = 0;
      index < entries.length;
      index += MAX_VECTOR_ENTRIES_PER_PACKET
    ) {
      this.sendToNeighbour(deviceId, "syncVector", {
        vector: entries.slice(index, index + MAX_VECTOR_ENTRIES_PER_PACKET),
      });
    }
  }

  private resetTrickle(): void {
    const minimum = this.options().minDigestIntervalMs;
    if (this.intervalMs !== minimum) {
      this.intervalMs = minimum;
      this.beginInterval();
    }
  }

  /** One Trickle interval: beacon at a random point in its second half unless suppressed. */
  private beginInterval(): void {
    this.clearTimer("beaconTimer");
    this.clearTimer("intervalTimer");
    if (!this.active) return;
    this.heardConsistent = 0;
    const interval = this.intervalMs;
    this.beaconTimer = setTimeout(
      () => {
        this.beaconTimer = null;
        if (
          this.options().repair &&
          this.heardConsistent < TRICKLE_REDUNDANCY
        ) {
          this.send(
            buildSyncPacket(
              this.link.localDeviceId,
              "syncDigest",
              this.scope,
              { digest: this.store.digest() },
              0,
              null,
            ),
            null,
            "Digest beacon",
          );
        }
      },
      interval / 2 + Math.random() * (interval / 2),
    );
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      const { maxDigestIntervalMs } = this.options();
      this.intervalMs = Math.min(this.intervalMs * 2, maxDigestIntervalMs);
      this.beginInterval();
    }, interval);
  }

  private clearTimer(name: "beaconTimer" | "intervalTimer"): void {
    const timer = this[name];
    if (timer !== null) clearTimeout(timer);
    this[name] = null;
  }

  private sendToNeighbour(
    deviceId: string,
    packetType: "syncItems" | "syncVector" | "syncRequest",
    body: Parameters<typeof buildSyncPacket>[3],
  ): void {
    void this.sendToNeighbourAsync(deviceId, packetType, body);
  }

  /** Resolves when the writes finish; never rejects (failures are logged). */
  private sendToNeighbourAsync(
    deviceId: string,
    packetType: "syncItems" | "syncVector" | "syncRequest",
    body: Parameters<typeof buildSyncPacket>[3],
  ): Promise<void> {
    return this.send(
      buildSyncPacket(
        this.link.localDeviceId,
        packetType,
        this.scope,
        body,
        0,
        deviceId,
      ),
      deviceId,
      packetType,
    );
  }

  private send(
    packet: MeshSessionPacket,
    targetDeviceId: string | null,
    description: string,
  ): Promise<void> {
    return this.link
      .sendSyncPacket(packet, targetDeviceId)
      .catch((error: unknown) => {
        this.log(
          "sync",
          `${description} failed`,
          { message: errorMessage(error) },
          "warn",
        );
      });
  }
}
