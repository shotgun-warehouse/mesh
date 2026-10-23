import type {
  LinkDirection,
  PeerConnectionEvent,
  PeerDisconnectionEvent,
  ReceivedMessage,
} from "../native/BleBroadcast.types";
import {
  IDENTITY_BEACON_INTERVAL_MS,
  MAX_PENDING_OWN_ITEM_PAYLOADS,
  MAX_PENDING_WIRE_PAYLOADS,
  MAX_SEEN_PACKET_IDS,
  RELAY_PUBLISH_DELAY_MS,
} from "./constants";
import type { MeshLogger } from "./logger";
import {
  buildIdentityPacket,
  buildRelayPacket,
  createPacketId,
  isSyncPacketType,
  decodeWirePacket,
  encodeWirePacket,
  type MeshSessionPacket,
} from "./packets";
import type { MeshTransport } from "./transport";

export type MeshIdentityEvent = {
  senderId: string;
  displayName?: string;
  bleDeviceId: string;
  deviceName: string | null;
  rssi: number;
  timestamp: number;
};

export type MeshLinkEvent = {
  bleDeviceId: string;
  /** The peer's device ID (see `PeerConnectionEvent.meshId`). Null while unknown. */
  deviceId: string | null;
  deviceName: string | null;
  rssi: number | null;
  direction: LinkDirection;
};

export type MeshRouterCallbacks = {
  onIdentity: (event: MeshIdentityEvent) => void;
  /** A link came up, or its device ID became known. */
  onLinkConnected?: (event: MeshLinkEvent) => void;
  /** The first link to a device came up: it is a direct neighbour. */
  onNeighbourUp?: (deviceId: string) => void;
  /** The last link to a device went down. */
  onNeighbourDown?: (deviceId: string) => void;
  onPeerCountChange?: (connectedPeerCount: number) => void;
  onRelay?: (packetId: string, ttl: number) => void;
  /** A sync packet for this device (or for every neighbour), and the link it arrived on. */
  onSyncPacket?: (packet: MeshSessionPacket, linkDeviceId: string) => void;
};

/** The radio and log sink a router runs on; the simulator runs many routers side by side. */
export type MeshRouterEnvironment = {
  transport: MeshTransport;
  logger: MeshLogger;
};

type PendingWirePublish = {
  wirePayload: string;
  excludeDeviceId: string | null;
  /** Only the neighbour with this device ID (sync packets for one neighbour). */
  targetDeviceId: string | null;
  /** False for periodic traffic (identity beacons) that is re-sent anyway and goes stale. */
  retryIfUnsent: boolean;
  /**
   * A part of an item this device published: queued under its own cap and sent without the relay
   * pacing (`MAX_PENDING_OWN_ITEM_PAYLOADS`, `RELAY_PUBLISH_DELAY_MS`).
   */
  isOwnItem: boolean;
};

/** Drops the oldest entries of one kind past `limit`; returns how many went. */
function dropOldest(
  queue: PendingWirePublish[],
  isOwnItem: boolean,
  limit: number,
): number {
  let count = queue.filter((entry) => entry.isOwnItem === isOwnItem).length;
  let droppedCount = 0;
  while (count > limit) {
    const index = queue.findIndex((entry) => entry.isOwnItem === isOwnItem);
    queue.splice(index, 1);
    count -= 1;
    droppedCount += 1;
  }
  return droppedCount;
}

function needsRetry(
  result: {
    sentCount: number;
    readyPeerCount: number;
    skippedExcluded: number;
  },
  connectedPeerCount: number,
): boolean {
  if (result.sentCount > 0) {
    return false;
  }

  if (connectedPeerCount === 0 || result.readyPeerCount === 0) {
    return true;
  }

  if (result.skippedExcluded >= result.readyPeerCount) {
    return false;
  }

  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Runs a send without awaiting it. Native rejects in-flight sends when Bluetooth goes away, so a
 * bare `void` would surface as an unhandled promise rejection.
 */
function runDetached(
  log: MeshLogger,
  task: Promise<void>,
  description: string,
): void {
  task.catch((taskError: unknown) => {
    log(
      "send",
      `${description} failed`,
      {
        message:
          taskError instanceof Error ? taskError.message : String(taskError),
      },
      "warn",
    );
  });
}

function linkKey(event: {
  deviceId: string;
  direction: LinkDirection;
}): string {
  return `${event.direction}:${event.deviceId}`;
}

export class MeshRouter {
  /**
   * Link (`direction:bleDeviceId`) → the device ID it reaches, for links whose device is known. A
   * neighbour is usually linked both ways, and stays one until its last link drops.
   */
  private readonly linkDevices = new Map<string, string>();
  private readonly seenPacketIds = new Set<string>();
  private readonly seenPacketOrder: string[] = [];
  private readonly pendingWirePayloads: PendingWirePublish[] = [];
  private isPublishing = false;
  private connectedPeerCount = 0;
  private identityTimer: ReturnType<typeof setInterval> | null = null;
  private messageSubscription: { remove: () => void } | null = null;
  private peerConnectedSubscription: { remove: () => void } | null = null;
  private peerDisconnectedSubscription: { remove: () => void } | null = null;
  private started = false;
  private identityPacketId = createPacketId();
  private readonly transport: MeshTransport;
  private readonly log: MeshLogger;

  constructor(
    private readonly localClientId: string,
    private localDisplayName: string,
    private readonly callbacks: MeshRouterCallbacks,
    { transport, logger }: MeshRouterEnvironment,
  ) {
    this.transport = transport;
    this.log = logger;
  }

  /** This device's ID, the sender of every packet it originates. */
  get localDeviceId(): string {
    return this.localClientId;
  }

  /** Renames this device on the mesh and announces the new name right away. */
  setDisplayName(displayName: string): void {
    if (displayName === this.localDisplayName) {
      return;
    }

    this.localDisplayName = displayName;
    // Peers drop identity packets whose ID they have already seen, so a new name needs a new ID.
    this.identityPacketId = createPacketId();

    this.log("identity", "Display name changed", { displayName });

    if (this.started) {
      runDetached(this.log, this.publishIdentityBeacon(), "Identity beacon");
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    this.log("router", "Mesh router starting", {
      localClientId: this.localClientId,
    });

    this.messageSubscription = this.transport.addListener(
      "onMessageReceived",
      (incomingMessage) => {
        this.handleIncoming(incomingMessage);
      },
    );

    this.peerConnectedSubscription = this.transport.addListener(
      "onPeerConnected",
      (linkEvent) => {
        runDetached(
          this.log,
          this.handlePeerLinkConnected(linkEvent),
          "Link setup",
        );
      },
    );

    this.peerDisconnectedSubscription = this.transport.addListener(
      "onPeerDisconnected",
      (disconnectEvent) => {
        this.handlePeerLinkDisconnected(disconnectEvent);
        runDetached(
          this.log,
          this.refreshConnectedPeerCount(),
          "Peer count refresh",
        );
      },
    );

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    this.identityTimer = setInterval(() => {
      runDetached(this.log, this.publishIdentityBeacon(), "Identity beacon");
    }, IDENTITY_BEACON_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.log("router", "Mesh router stopping");
    this.started = false;
    if (this.identityTimer) {
      clearInterval(this.identityTimer);
      this.identityTimer = null;
    }
    this.messageSubscription?.remove();
    this.peerConnectedSubscription?.remove();
    this.peerDisconnectedSubscription?.remove();
    this.messageSubscription = null;
    this.peerConnectedSubscription = null;
    this.peerDisconnectedSubscription = null;
    this.pendingWirePayloads.length = 0;
    this.linkDevices.clear();
  }

  private async handlePeerLinkConnected(
    linkEvent: PeerConnectionEvent,
  ): Promise<void> {
    this.log("link", "Peer link connected", {
      bleDeviceId: linkEvent.deviceId,
      deviceId: linkEvent.meshId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
      direction: linkEvent.direction,
    });

    this.callbacks.onLinkConnected?.({
      bleDeviceId: linkEvent.deviceId,
      deviceId: linkEvent.meshId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
      direction: linkEvent.direction,
    });

    if (linkEvent.meshId) {
      this.trackLink(linkKey(linkEvent), linkEvent.meshId);
    }

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    await this.flushPendingWirePayloads();
  }

  /** A disconnect of a link that was never reported up (or whose device was unknown) is ignored. */
  private handlePeerLinkDisconnected(
    disconnectEvent: PeerDisconnectionEvent,
  ): void {
    const key = linkKey(disconnectEvent);
    const deviceId = this.linkDevices.get(key);
    if (!deviceId) {
      return;
    }
    this.linkDevices.delete(key);
    this.dropNeighbourIfUnlinked(deviceId);
  }

  private trackLink(key: string, deviceId: string): void {
    const previousDeviceId = this.linkDevices.get(key);
    if (previousDeviceId === deviceId) {
      return;
    }
    const isNewNeighbour = !this.isLinked(deviceId);
    this.linkDevices.set(key, deviceId);
    if (previousDeviceId) {
      this.dropNeighbourIfUnlinked(previousDeviceId);
    }
    if (isNewNeighbour) {
      this.callbacks.onNeighbourUp?.(deviceId);
    }
  }

  private dropNeighbourIfUnlinked(deviceId: string): void {
    if (!this.isLinked(deviceId)) {
      this.callbacks.onNeighbourDown?.(deviceId);
    }
  }

  private isLinked(deviceId: string): boolean {
    for (const linkedDeviceId of this.linkDevices.values()) {
      if (linkedDeviceId === deviceId) {
        return true;
      }
    }
    return false;
  }

  private async publishIdentityBeacon(): Promise<void> {
    // Beacons are periodic and re-sent on every new link, so nobody to talk to means nothing to do.
    if (this.connectedPeerCount === 0) {
      return;
    }
    const packet = buildIdentityPacket(
      this.localClientId,
      this.localDisplayName,
      this.identityPacketId,
    );
    this.markSeen(packet.id);
    await this.publishPacket(packet);
  }

  private handleIncoming(incomingMessage: ReceivedMessage): void {
    const packet = decodeWirePacket(incomingMessage.jsonMessage);
    if (!packet) {
      this.log(
        "receive",
        "Dropped payload — failed to decode wire packet",
        {
          linkDeviceId: incomingMessage.deviceId,
          wireChars: incomingMessage.jsonMessage.length,
        },
        "warn",
      );
      return;
    }

    if (this.hasSeen(packet.id)) {
      this.log("dedup", "Skipped already-seen packet", {
        packetId: packet.id,
        packetType: packet.packetType,
        senderId: packet.senderId,
      });
      return;
    }

    this.markSeen(packet.id);

    this.log("receive", "Accepted incoming packet", {
      packetId: packet.id,
      packetType: packet.packetType,
      senderId: packet.senderId,
      ttl: packet.ttl,
      linkDeviceId: incomingMessage.deviceId,
      wireChars: incomingMessage.jsonMessage.length,
    });

    if (packet.senderId !== this.localClientId) {
      this.processPacket(packet, incomingMessage);
      // Link-local sync packets (TTL 0) are never relayed.
      if (isSyncPacketType(packet.packetType) && packet.ttl <= 0) {
        return;
      }
      const linkDeviceId =
        incomingMessage.viaDeviceId ?? incomingMessage.deviceId;
      this.scheduleRelay(packet, linkDeviceId);
    }
  }

  private processPacket(
    packet: MeshSessionPacket,
    incomingMessage: ReceivedMessage,
  ): void {
    if (isSyncPacketType(packet.packetType)) {
      const forAnotherDevice =
        packet.recipientId !== null &&
        packet.recipientId.toLowerCase() !== this.localClientId.toLowerCase();
      if (!forAnotherDevice) {
        this.callbacks.onSyncPacket?.(
          packet,
          incomingMessage.viaDeviceId ?? incomingMessage.deviceId,
        );
      }
      return;
    }

    if (packet.packetType === "identity") {
      this.log("identity", "Received identity beacon", {
        senderId: packet.senderId,
        displayName: packet.displayName,
      });
      this.callbacks.onIdentity({
        senderId: packet.senderId,
        displayName: packet.displayName,
        bleDeviceId: incomingMessage.deviceId,
        deviceName: incomingMessage.deviceName,
        rssi: incomingMessage.rssi,
        timestamp: incomingMessage.timestamp,
      });
    }
  }

  private scheduleRelay(
    packet: MeshSessionPacket,
    excludeDeviceId: string,
  ): void {
    const relayPacket = buildRelayPacket(packet);
    if (!relayPacket) {
      this.log("relay", "Relay skipped — TTL exhausted", {
        packetId: packet.id,
        packetType: packet.packetType,
      });
      return;
    }

    this.log("relay", "Scheduling relay", {
      packetId: relayPacket.id,
      packetType: relayPacket.packetType,
      ttl: relayPacket.ttl,
      excludeDeviceId,
    });

    this.callbacks.onRelay?.(relayPacket.id, relayPacket.ttl);
    runDetached(
      this.log,
      this.publishPacket(relayPacket, excludeDeviceId),
      "Relay",
    );
  }

  /**
   * Sends a sync packet. Above TTL 0 it floods like any packet (queued and retried when no peer
   * accepted it). At TTL 0 it is written straight to direct neighbours (just `targetDeviceId`
   * when set) and resolves once the writes finish: link-local repair traffic stays out of the
   * relay queue and its pacing, and is never retried (the next sync round re-sends what is
   * still missing).
   */
  async sendSyncPacket(
    packet: MeshSessionPacket,
    targetDeviceId: string | null,
  ): Promise<void> {
    this.markSeen(packet.id);
    const pendingPublish: PendingWirePublish = {
      wirePayload: encodeWirePacket(packet),
      excludeDeviceId: null,
      targetDeviceId,
      retryIfUnsent: packet.ttl > 0,
      isOwnItem: packet.ttl > 0,
    };
    if (packet.ttl > 0) {
      await this.publishWire(pendingPublish);
      return;
    }
    // Repair packets are not retried: one written to nobody is lost until the next exchange.
    const result = await this.sendWire(pendingPublish);
    if (result.sentCount === 0) {
      this.log(
        "send",
        "Direct packet reached no link",
        {
          packetType: packet.packetType,
          targetDeviceId,
          readyPeerCount: result.readyPeerCount,
          connectedPeerCount: this.connectedPeerCount,
        },
        "warn",
      );
    }
  }

  /**
   * One write round. A targeted write that reached nobody while links are up goes to every
   * neighbour instead: the target's link may not carry its device ID (an iOS peer advertising in
   * the background), and the packet's recipient keeps other neighbours from acting on it.
   */
  private async sendWire(pendingPublish: PendingWirePublish): Promise<{
    sentCount: number;
    readyPeerCount: number;
    skippedExcluded: number;
  }> {
    const { wirePayload, excludeDeviceId, targetDeviceId } = pendingPublish;
    const result = await this.transport.sendPacketAsync(
      wirePayload,
      excludeDeviceId,
      targetDeviceId,
    );
    if (
      targetDeviceId === null ||
      result.sentCount > 0 ||
      result.readyPeerCount === 0
    ) {
      return result;
    }
    this.log("send", "Target link unknown; writing to every neighbour", {
      targetDeviceId,
      readyPeerCount: result.readyPeerCount,
    });
    return this.transport.sendPacketAsync(wirePayload, excludeDeviceId, null);
  }

  private async publishPacket(
    packet: MeshSessionPacket,
    excludeDeviceId: string | null = null,
  ): Promise<void> {
    await this.publishWire({
      wirePayload: encodeWirePacket(packet),
      excludeDeviceId,
      targetDeviceId: null,
      retryIfUnsent: packet.packetType !== "identity",
      isOwnItem: false,
    });
  }

  private enqueuePendingWirePayload(
    pendingPublish: PendingWirePublish,
    reason: string,
    level: "info" | "warn" = "info",
  ): void {
    this.pendingWirePayloads.push(pendingPublish);

    const droppedCount = pendingPublish.isOwnItem
      ? dropOldest(
          this.pendingWirePayloads,
          true,
          MAX_PENDING_OWN_ITEM_PAYLOADS,
        )
      : dropOldest(this.pendingWirePayloads, false, MAX_PENDING_WIRE_PAYLOADS);

    this.log(
      "queue",
      `Queued wire payload — ${reason}`,
      {
        wireChars: pendingPublish.wirePayload.length,
        excludeDeviceId: pendingPublish.excludeDeviceId,
        queueDepth: this.pendingWirePayloads.length,
        droppedCount,
      },
      droppedCount > 0 ? "warn" : level,
    );
  }

  private async publishWire(pendingPublish: PendingWirePublish): Promise<void> {
    const { wirePayload, excludeDeviceId } = pendingPublish;

    if (this.isPublishing) {
      this.enqueuePendingWirePayload(pendingPublish, "publish in progress");
      return;
    }

    this.isPublishing = true;

    try {
      const result = await this.sendWire(pendingPublish);

      this.log("send", "sendPacketAsync completed", {
        wireChars: wirePayload.length,
        sentCount: result.sentCount,
        readyPeerCount: result.readyPeerCount,
        skippedExcluded: result.skippedExcluded,
        excludeDeviceId,
        connectedPeerCount: this.connectedPeerCount,
      });

      if (needsRetry(result, this.connectedPeerCount)) {
        if (pendingPublish.retryIfUnsent) {
          this.enqueuePendingWirePayload(
            pendingPublish,
            "no peers accepted write",
            "warn",
          );
        } else {
          this.log("queue", "Dropped unsent non-retryable wire payload", {
            wireChars: wirePayload.length,
            excludeDeviceId,
          });
        }
      } else if (
        result.sentCount === 0 &&
        result.skippedExcluded >= result.readyPeerCount &&
        result.readyPeerCount > 0
      ) {
        this.log("relay", "Relay complete — all ready links excluded", {
          wireChars: wirePayload.length,
          excludeDeviceId,
          readyPeerCount: result.readyPeerCount,
        });
      }
    } catch (error) {
      // Not re-queued: the packet is lost for every neighbour, not only the failing one.
      this.log(
        "send",
        "Write failed; packet dropped",
        {
          wireChars: wirePayload.length,
          excludeDeviceId,
          message: error instanceof Error ? error.message : String(error),
        },
        "warn",
      );
      throw error;
    } finally {
      this.isPublishing = false;
      runDetached(this.log, this.flushPendingWirePayloads(), "Queue flush");
    }
  }

  private async flushPendingWirePayloads(): Promise<void> {
    if (this.isPublishing || this.pendingWirePayloads.length === 0) {
      return;
    }

    if (this.connectedPeerCount === 0) {
      this.log(
        "queue",
        "Pending queue not flushed — no connected peers",
        {
          queueDepth: this.pendingWirePayloads.length,
        },
        "warn",
      );
      return;
    }

    this.log("queue", "Flushing pending wire payloads", {
      queueDepth: this.pendingWirePayloads.length,
      connectedPeerCount: this.connectedPeerCount,
    });

    this.isPublishing = true;

    try {
      while (this.pendingWirePayloads.length > 0) {
        const pendingPublish = this.pendingWirePayloads.shift();
        if (!pendingPublish) {
          continue;
        }

        const result = await this.sendWire(pendingPublish);

        if (needsRetry(result, this.connectedPeerCount)) {
          if (!pendingPublish.retryIfUnsent) {
            this.log("queue", "Dropped unsent non-retryable wire payload", {
              wireChars: pendingPublish.wirePayload.length,
              excludeDeviceId: pendingPublish.excludeDeviceId,
            });
            continue;
          }

          this.log(
            "queue",
            "Flush paused — send returned sentCount=0",
            {
              wireChars: pendingPublish.wirePayload.length,
              excludeDeviceId: pendingPublish.excludeDeviceId,
              remainingQueueDepth: this.pendingWirePayloads.length,
            },
            "warn",
          );
          this.pendingWirePayloads.unshift(pendingPublish);
          break;
        }

        if (
          result.sentCount === 0 &&
          result.skippedExcluded >= result.readyPeerCount &&
          result.readyPeerCount > 0
        ) {
          this.log("relay", "Relay complete — all ready links excluded", {
            wireChars: pendingPublish.wirePayload.length,
            excludeDeviceId: pendingPublish.excludeDeviceId,
            readyPeerCount: result.readyPeerCount,
          });
        }

        this.log("queue", "Flushed queued wire payload", {
          wireChars: pendingPublish.wirePayload.length,
          sentCount: result.sentCount,
          excludeDeviceId: pendingPublish.excludeDeviceId,
          remainingQueueDepth: this.pendingWirePayloads.length,
        });

        if (!pendingPublish.isOwnItem) {
          await delay(RELAY_PUBLISH_DELAY_MS);
        }
      }
    } finally {
      this.isPublishing = false;
    }
  }

  private async refreshConnectedPeerCount(): Promise<void> {
    const previousCount = this.connectedPeerCount;
    this.connectedPeerCount = await this.transport.getConnectedPeerCountAsync();

    if (previousCount !== this.connectedPeerCount) {
      this.log("link", "Connected peer count changed", {
        previousCount,
        connectedPeerCount: this.connectedPeerCount,
      });
    }

    this.callbacks.onPeerCountChange?.(this.connectedPeerCount);
  }

  private hasSeen(packetId: string): boolean {
    return this.seenPacketIds.has(packetId);
  }

  private markSeen(packetId: string): void {
    if (this.seenPacketIds.has(packetId)) {
      return;
    }

    this.seenPacketIds.add(packetId);
    this.seenPacketOrder.push(packetId);

    while (this.seenPacketOrder.length > MAX_SEEN_PACKET_IDS) {
      const oldestPacketId = this.seenPacketOrder.shift();
      if (oldestPacketId) {
        this.seenPacketIds.delete(oldestPacketId);
      }
    }
  }
}
