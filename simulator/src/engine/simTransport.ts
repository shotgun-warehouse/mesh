import { base64ToBytes } from "@mesh/bytes";
import { MAX_WIRE_BYTES } from "@mesh/constants";
import type { MeshTransport, MeshTransportEvents } from "@mesh/transport";

import type { Link, Medium } from "./medium";
import { peerOf, rssiAt } from "./medium";
import type { Rng } from "./random";
import type { PacketKind } from "./types";

/** Extra write latency per meter of distance. */
const LATENCY_PER_METER_MS = 0.2;

export type InFlightPacket = {
  id: number;
  from: string;
  to: string;
  kind: PacketKind;
  bytes: number;
  start: number;
  end: number;
  /** Known at start (loss roll); a link drop mid-write fails it too. */
  failed: boolean;
  wirePayload: string;
};

export type WriteOutcome = "ok" | "loss" | "linkDown" | "poweredDown";

/** What a transport needs from the engine around it. */
export type TransportWorld = {
  readonly medium: Medium;
  readonly lossRng: Rng;
  now(): number;
  meshIdOf(deviceId: string): string;
  labelOf(deviceId: string): string;
  transportOf(deviceId: string): SimTransport | undefined;
  beginPacket(packet: Omit<InFlightPacket, "id">): InFlightPacket;
  endPacket(packet: InFlightPacket, outcome: WriteOutcome): void;
  onOversizePacket(deviceId: string, bytes: number): void;
};

type ReceivedMessage = Parameters<MeshTransportEvents["onMessageReceived"]>[0];
type SendPacketResult = Awaited<ReturnType<MeshTransport["sendPacketAsync"]>>;

type ListenerSets = {
  [EventName in keyof MeshTransportEvents]: Set<MeshTransportEvents[EventName]>;
};

export class TransportPoweredDownError extends Error {
  constructor() {
    super("Bluetooth is off");
  }
}

export function wireByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Packet kind from the wire header (type byte at offset 3), without a full decode. */
export function wirePacketKind(wirePayload: string): PacketKind {
  const header = base64ToBytes(wirePayload.slice(0, 8));
  switch (header?.[3]) {
    case 1:
      return "identity";
    case 2:
      return "item";
    default:
      return "sync";
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * `MeshTransport` over the simulated medium, with the native modules' observable contract:
 * writes go to every ready link one at a time, each waits for its (simulated) ACK, a device has
 * one write in flight, failed writes are not counted in `sentCount`, and packets over
 * `MAX_WIRE_BYTES` are rejected. Links are identified by the peer's mesh ID, which is also what
 * `targetDeviceId` matches.
 */
export class SimTransport implements MeshTransport {
  private readonly listeners: ListenerSets = {
    onMessageReceived: new Set(),
    onPeerConnected: new Set(),
    onPeerDisconnected: new Set(),
  };
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  /** Writes waiting for, or holding, this device's single write slot. */
  queuedJobs = 0;

  constructor(
    private readonly world: TransportWorld,
    readonly deviceId: string,
  ) {}

  addListener<EventName extends keyof MeshTransportEvents>(
    eventName: EventName,
    listener: MeshTransportEvents[EventName],
  ): { remove: () => void } {
    const listeners = this.listeners[eventName] as Set<
      MeshTransportEvents[EventName]
    >;
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  }

  listenerCount(): number {
    return (
      this.listeners.onMessageReceived.size +
      this.listeners.onPeerConnected.size +
      this.listeners.onPeerDisconnected.size
    );
  }

  sendPacketAsync(
    wirePayload: string,
    excludeDeviceId: string | null,
    targetDeviceId: string | null,
  ): Promise<SendPacketResult> {
    const bytes = wireByteLength(wirePayload);
    if (bytes > MAX_WIRE_BYTES) {
      this.world.onOversizePacket(this.deviceId, bytes);
      return Promise.reject(
        new Error(
          `Packet of ${bytes} bytes exceeds the ${MAX_WIRE_BYTES}-byte ATT limit`,
        ),
      );
    }

    const kind = wirePacketKind(wirePayload);
    return this.enqueue(async () => {
      const links = this.world.medium.readyLinksOf(this.deviceId);
      let sentCount = 0;
      let skippedExcluded = 0;
      for (const link of links) {
        const peerId = peerOf(link, this.deviceId);
        const peerMeshId = this.world.meshIdOf(peerId);
        if (targetDeviceId !== null && peerMeshId !== targetDeviceId) {
          continue;
        }
        if (excludeDeviceId !== null && peerMeshId === excludeDeviceId) {
          skippedExcluded += 1;
          continue;
        }
        const delivered = await this.write(
          link,
          peerId,
          wirePayload,
          bytes,
          kind,
          () => {
            this.world.transportOf(peerId)?.receive(this.deviceId, wirePayload);
          },
        );
        if (delivered) {
          sentCount += 1;
        }
      }
      return { sentCount, readyPeerCount: links.length, skippedExcluded };
    });
  }

  /** Mesh IDs of the peers on this device's ready links. */
  readyPeerMeshIds(): string[] {
    return this.world.medium
      .readyLinksOf(this.deviceId)
      .map((link) => this.world.meshIdOf(peerOf(link, this.deviceId)));
  }

  async getConnectedPeerCountAsync(): Promise<number> {
    return this.world.medium.readyLinksOf(this.deviceId).length;
  }

  /** Bluetooth went away: queued and in-flight writes fail, like the native modules. */
  powerDown(): void {
    this.generation += 1;
  }

  emitPeerConnected(peerId: string): void {
    const meshId = this.world.meshIdOf(peerId);
    const event = {
      deviceId: meshId,
      meshId,
      deviceName: this.world.labelOf(peerId),
      rssi: this.rssiTo(peerId),
      // One simulated link per pair stands for both directions.
      direction: "outbound" as const,
    };
    for (const listener of [...this.listeners.onPeerConnected]) {
      listener(event);
    }
  }

  emitPeerDisconnected(peerId: string): void {
    const meshId = this.world.meshIdOf(peerId);
    for (const listener of [...this.listeners.onPeerDisconnected]) {
      listener({ deviceId: meshId, meshId, direction: "outbound" });
    }
  }

  private receive(fromDeviceId: string, wirePayload: string): void {
    const meshId = this.world.meshIdOf(fromDeviceId);
    const message: ReceivedMessage = {
      deviceId: meshId,
      viaDeviceId: meshId,
      deviceName: this.world.labelOf(fromDeviceId),
      jsonMessage: wirePayload,
      rssi: this.rssiTo(fromDeviceId),
      truncated: false,
      source: "gatt",
      timestamp: Date.now(),
    };
    for (const listener of [...this.listeners.onMessageReceived]) {
      listener(message);
    }
  }

  private rssiTo(peerId: string): number {
    return rssiAt(this.world.medium.distanceBetween(this.deviceId, peerId));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    this.queuedJobs += 1;
    const result = this.tail.then(() => {
      if (generation !== this.generation) {
        throw new TransportPoweredDownError();
      }
      return job();
    });
    const settled = result.then(
      () => {
        this.queuedJobs -= 1;
      },
      () => {
        this.queuedJobs -= 1;
      },
    );
    this.tail = settled;
    return result;
  }

  private async write(
    link: Link,
    peerId: string,
    wirePayload: string,
    bytes: number,
    kind: PacketKind,
    deliver: () => void,
  ): Promise<boolean> {
    const { medium, lossRng } = this.world;
    const params = medium.params;
    const meters = medium.distanceBetween(this.deviceId, peerId);
    const latency = Math.max(
      1,
      params.writeLatencyMs +
        (2 * lossRng() - 1) * params.jitterMs +
        meters * LATENCY_PER_METER_MS,
    );
    const lost = lossRng() < params.writeLoss;
    const epoch = link.epoch;
    const generation = this.generation;
    const start = this.world.now();
    const packet = this.world.beginPacket({
      from: this.deviceId,
      to: peerId,
      kind,
      bytes,
      start,
      end: start + latency,
      failed: lost,
      wirePayload,
    });

    await sleep(latency);

    const linkAlive =
      medium.links.get(link.key) === link &&
      link.state === "up" &&
      link.epoch === epoch;
    let outcome: WriteOutcome = "ok";
    if (generation !== this.generation) {
      outcome = "poweredDown";
    } else if (!linkAlive) {
      outcome = "linkDown";
    } else if (lost) {
      outcome = "loss";
    }
    medium.recordWrite(
      link.key,
      outcome === "ok",
      bytes,
      latency,
      this.world.now(),
    );
    this.world.endPacket(packet, outcome);
    if (outcome !== "ok") {
      return false;
    }
    deliver();
    return true;
  }
}
