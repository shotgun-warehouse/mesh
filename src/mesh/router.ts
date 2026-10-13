import BleBroadcast, {
  type PeerConnectionEvent,
  type ReceivedMessage,
} from "../native";
import {
  FRAGMENT_PUBLISH_DELAY_MS,
  IDENTITY_BEACON_INTERVAL_MS,
  MAX_PENDING_WIRE_PAYLOADS,
  MAX_SEEN_PACKET_IDS,
  RELAY_PUBLISH_DELAY_MS,
} from "./constants";
import { FragmentAssembler } from "./fragments";
import { meshLog } from "./logger";
import {
  buildIdentityPacket,
  buildMessageWirePackets,
  buildRelayPacket,
  createPacketId,
  decodeWirePacket,
  encodeWirePacket,
  type MeshSessionPacket,
  wirePacketByteLength,
} from "./packets";

export type MeshIdentityEvent = {
  senderId: string;
  displayName?: string;
  bleDeviceId: string;
  deviceName: string | null;
  rssi: number;
  timestamp: number;
};

export type MeshChatEvent = {
  senderId: string;
  displayName?: string;
  messageId: string;
  text: string;
  recipientId: string | null;
  timestamp: number;
  bleDeviceId: string;
  deviceName: string | null;
  rssi: number;
};

export type MeshLinkEvent = {
  bleDeviceId: string;
  /** The peer's device ID from its advertisement; null when the advertisement lacked it. */
  deviceId: string | null;
  deviceName: string | null;
  rssi: number;
};

export type MeshLinkDisconnectEvent = {
  bleDeviceId: string;
  deviceId: string | null;
};

export type MeshRouterCallbacks = {
  onIdentity: (event: MeshIdentityEvent) => void;
  onChatMessage: (event: MeshChatEvent) => void;
  onLinkConnected?: (event: MeshLinkEvent) => void;
  onLinkDisconnected?: (event: MeshLinkDisconnectEvent) => void;
  onPeerCountChange?: (connectedPeerCount: number) => void;
  onRelay?: (packetId: string, ttl: number) => void;
};

type PendingWirePublish = {
  wirePayload: string;
  excludeDeviceId: string | null;
  /** False for periodic traffic (identity beacons) that is re-sent anyway and goes stale. */
  retryIfUnsent: boolean;
};

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
function runDetached(task: Promise<void>, description: string): void {
  task.catch((taskError: unknown) => {
    meshLog(
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

function isFragmentPacketType(
  packetType: MeshSessionPacket["packetType"],
): boolean {
  return (
    packetType === "fragmentStart" ||
    packetType === "fragmentContinue" ||
    packetType === "fragmentEnd"
  );
}

export class MeshRouter {
  private readonly seenPacketIds = new Set<string>();
  private readonly seenPacketOrder: string[] = [];
  private readonly fragmentAssembler = new FragmentAssembler();
  private readonly pendingWirePayloads: PendingWirePublish[] = [];
  private isPublishing = false;
  private outboundTransferDepth = 0;
  private connectedPeerCount = 0;
  private identityTimer: ReturnType<typeof setInterval> | null = null;
  private messageSubscription: { remove: () => void } | null = null;
  private peerConnectedSubscription: { remove: () => void } | null = null;
  private peerDisconnectedSubscription: { remove: () => void } | null = null;
  private started = false;
  private identityPacketId = createPacketId();

  constructor(
    private readonly localClientId: string,
    private localDisplayName: string,
    private readonly callbacks: MeshRouterCallbacks,
  ) {}

  /** Renames this device on the mesh and announces the new name right away. */
  setDisplayName(displayName: string): void {
    if (displayName === this.localDisplayName) {
      return;
    }

    this.localDisplayName = displayName;
    // Peers drop identity packets whose ID they have already seen, so a new name needs a new ID.
    this.identityPacketId = createPacketId();

    meshLog("identity", "Display name changed", { displayName });

    if (this.started) {
      runDetached(this.publishIdentityBeacon(), "Identity beacon");
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    meshLog("router", "Mesh router starting", {
      localClientId: this.localClientId,
    });

    this.messageSubscription = BleBroadcast.addListener(
      "onMessageReceived",
      (incomingMessage) => {
        this.handleIncoming(incomingMessage);
      },
    );

    this.peerConnectedSubscription = BleBroadcast.addListener(
      "onPeerConnected",
      (linkEvent) => {
        runDetached(this.handlePeerLinkConnected(linkEvent), "Link setup");
      },
    );

    this.peerDisconnectedSubscription = BleBroadcast.addListener(
      "onPeerDisconnected",
      (disconnectEvent) => {
        this.callbacks.onLinkDisconnected?.({
          bleDeviceId: disconnectEvent.deviceId,
          deviceId: disconnectEvent.meshId,
        });
        runDetached(this.refreshConnectedPeerCount(), "Peer count refresh");
      },
    );

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    this.identityTimer = setInterval(() => {
      runDetached(this.publishIdentityBeacon(), "Identity beacon");
    }, IDENTITY_BEACON_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    meshLog("router", "Mesh router stopping");
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
  }

  async sendBroadcast(json: string, messageId: string): Promise<void> {
    return this.sendChatMessage(null, json, messageId);
  }

  async sendChatMessage(
    recipientId: string | null,
    text: string,
    messageId: string,
  ): Promise<void> {
    const packets = buildMessageWirePackets(
      this.localClientId,
      this.localDisplayName,
      text,
      recipientId,
      messageId,
    );

    meshLog("send", "Publishing chat message", {
      messageId,
      recipientId,
      textChars: text.length,
      packetCount: packets.length,
      packetTypes: packets.map((packet) => packet.packetType),
      wireChars: packets.map((packet) => wirePacketByteLength(packet)),
      fragmented: packets.some((packet) =>
        packet.packetType.startsWith("fragment"),
      ),
    });

    const isFragmentedTransfer = packets.length > 1;
    if (isFragmentedTransfer) {
      this.outboundTransferDepth += 1;
    }

    try {
      for (
        let packetIndex = 0;
        packetIndex < packets.length;
        packetIndex += 1
      ) {
        const packet = packets[packetIndex]!;
        this.markSeen(packet.id);
        await this.publishPacket(packet);

        const isLastPacket = packetIndex === packets.length - 1;
        if (isFragmentedTransfer && !isLastPacket) {
          await delay(FRAGMENT_PUBLISH_DELAY_MS);
        }
      }
    } finally {
      if (isFragmentedTransfer) {
        this.outboundTransferDepth -= 1;
        runDetached(this.flushPendingWirePayloads(), "Queue flush");
      }
    }
  }

  private shouldAllowOutboundBackgroundTraffic(): boolean {
    return (
      this.outboundTransferDepth === 0 &&
      !this.fragmentAssembler.hasActiveTransfers()
    );
  }

  private async handlePeerLinkConnected(
    linkEvent: PeerConnectionEvent,
  ): Promise<void> {
    meshLog("link", "Peer link connected", {
      bleDeviceId: linkEvent.deviceId,
      deviceId: linkEvent.meshId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
    });

    this.callbacks.onLinkConnected?.({
      bleDeviceId: linkEvent.deviceId,
      deviceId: linkEvent.meshId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
    });

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    await this.flushPendingWirePayloads();
  }

  private async publishIdentityBeacon(): Promise<void> {
    // Beacons are periodic and re-sent on every new link, so nobody to talk to means nothing to do.
    if (
      this.connectedPeerCount === 0 ||
      !this.shouldAllowOutboundBackgroundTraffic()
    ) {
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
      meshLog(
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
      meshLog("dedup", "Skipped already-seen packet", {
        packetId: packet.id,
        packetType: packet.packetType,
        senderId: packet.senderId,
      });
      return;
    }

    this.markSeen(packet.id);

    meshLog("receive", "Accepted incoming packet", {
      packetId: packet.id,
      packetType: packet.packetType,
      senderId: packet.senderId,
      ttl: packet.ttl,
      linkDeviceId: incomingMessage.deviceId,
      wireChars: incomingMessage.jsonMessage.length,
    });

    if (packet.senderId !== this.localClientId) {
      this.processPacket(packet, incomingMessage);
      const linkDeviceId =
        incomingMessage.viaDeviceId ?? incomingMessage.deviceId;
      this.scheduleRelay(packet, linkDeviceId);
    }
  }

  private processPacket(
    packet: MeshSessionPacket,
    incomingMessage: ReceivedMessage,
  ): void {
    if (packet.packetType === "identity") {
      meshLog("identity", "Received identity beacon", {
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
      return;
    }

    if (packet.packetType === "message") {
      meshLog("message", "Received complete message packet", {
        messageId: packet.messageId,
        senderId: packet.senderId,
        textChars: packet.text?.length ?? 0,
      });
      this.deliverChatPacket(packet, incomingMessage);
      return;
    }

    const assembledMessage = this.fragmentAssembler.ingest(packet);
    if (!assembledMessage) {
      if (!this.fragmentAssembler.hasActiveTransfers()) {
        runDetached(this.flushPendingWirePayloads(), "Queue flush");
      }
      return;
    }

    runDetached(this.flushPendingWirePayloads(), "Queue flush");

    meshLog("fragment", "Reassembled fragmented message", {
      messageId: assembledMessage.messageId,
      senderId: assembledMessage.senderId,
      textChars: assembledMessage.text.length,
      transferId: packet.transferId,
    });

    this.deliverChatPacket(
      {
        ...packet,
        packetType: "message",
        senderId: assembledMessage.senderId,
        recipientId: assembledMessage.recipientId,
        messageId: assembledMessage.messageId,
        displayName: assembledMessage.displayName,
        text: assembledMessage.text,
        ts: assembledMessage.ts,
      },
      incomingMessage,
    );
  }

  private deliverChatPacket(
    packet: MeshSessionPacket,
    incomingMessage: ReceivedMessage,
  ): void {
    if (!packet.messageId || !packet.text) {
      return;
    }

    if (
      packet.recipientId &&
      packet.recipientId.toLowerCase() !== this.localClientId.toLowerCase()
    ) {
      meshLog("message", "Skipped message — not addressed to this client", {
        messageId: packet.messageId,
        recipientId: packet.recipientId,
        localClientId: this.localClientId,
      });
      return;
    }

    meshLog("message", "Delivering chat message to UI", {
      messageId: packet.messageId,
      senderId: packet.senderId,
      textChars: packet.text.length,
    });

    this.callbacks.onChatMessage({
      senderId: packet.senderId,
      displayName: packet.displayName,
      messageId: packet.messageId,
      text: packet.text,
      recipientId: packet.recipientId,
      timestamp: packet.ts,
      bleDeviceId: incomingMessage.deviceId,
      deviceName: incomingMessage.deviceName,
      rssi: incomingMessage.rssi,
    });
  }

  private scheduleRelay(
    packet: MeshSessionPacket,
    excludeDeviceId: string,
  ): void {
    if (isFragmentPacketType(packet.packetType)) {
      return;
    }

    if (!this.shouldAllowOutboundBackgroundTraffic()) {
      return;
    }

    const relayPacket = buildRelayPacket(packet);
    if (!relayPacket) {
      meshLog("relay", "Relay skipped — TTL exhausted", {
        packetId: packet.id,
        packetType: packet.packetType,
      });
      return;
    }

    meshLog("relay", "Scheduling relay", {
      packetId: relayPacket.id,
      packetType: relayPacket.packetType,
      ttl: relayPacket.ttl,
      excludeDeviceId,
    });

    this.callbacks.onRelay?.(relayPacket.id, relayPacket.ttl);
    runDetached(this.publishPacket(relayPacket, excludeDeviceId), "Relay");
  }

  private async publishPacket(
    packet: MeshSessionPacket,
    excludeDeviceId: string | null = null,
  ): Promise<void> {
    await this.publishWire({
      wirePayload: encodeWirePacket(packet),
      excludeDeviceId,
      retryIfUnsent: packet.packetType !== "identity",
    });
  }

  private enqueuePendingWirePayload(
    pendingPublish: PendingWirePublish,
    reason: string,
    level: "info" | "warn" = "info",
  ): void {
    this.pendingWirePayloads.push(pendingPublish);

    let droppedCount = 0;
    while (this.pendingWirePayloads.length > MAX_PENDING_WIRE_PAYLOADS) {
      this.pendingWirePayloads.shift();
      droppedCount += 1;
    }

    meshLog(
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
      const result = await BleBroadcast.sendPacketAsync(
        wirePayload,
        excludeDeviceId,
      );

      meshLog("send", "sendPacketAsync completed", {
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
          meshLog("queue", "Dropped unsent non-retryable wire payload", {
            wireChars: wirePayload.length,
            excludeDeviceId,
          });
        }
      } else if (
        result.sentCount === 0 &&
        result.skippedExcluded >= result.readyPeerCount &&
        result.readyPeerCount > 0
      ) {
        meshLog("relay", "Relay complete — all ready links excluded", {
          wireChars: wirePayload.length,
          excludeDeviceId,
          readyPeerCount: result.readyPeerCount,
        });
      }
    } finally {
      this.isPublishing = false;
      runDetached(this.flushPendingWirePayloads(), "Queue flush");
    }
  }

  private async flushPendingWirePayloads(): Promise<void> {
    if (this.isPublishing || this.pendingWirePayloads.length === 0) {
      return;
    }

    if (!this.shouldAllowOutboundBackgroundTraffic()) {
      return;
    }

    if (this.connectedPeerCount === 0) {
      meshLog(
        "queue",
        "Pending queue not flushed — no connected peers",
        {
          queueDepth: this.pendingWirePayloads.length,
        },
        "warn",
      );
      return;
    }

    meshLog("queue", "Flushing pending wire payloads", {
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

        const result = await BleBroadcast.sendPacketAsync(
          pendingPublish.wirePayload,
          pendingPublish.excludeDeviceId,
        );

        if (needsRetry(result, this.connectedPeerCount)) {
          if (!pendingPublish.retryIfUnsent) {
            meshLog("queue", "Dropped unsent non-retryable wire payload", {
              wireChars: pendingPublish.wirePayload.length,
              excludeDeviceId: pendingPublish.excludeDeviceId,
            });
            continue;
          }

          meshLog(
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
          meshLog("relay", "Relay complete — all ready links excluded", {
            wireChars: pendingPublish.wirePayload.length,
            excludeDeviceId: pendingPublish.excludeDeviceId,
            readyPeerCount: result.readyPeerCount,
          });
        }

        meshLog("queue", "Flushed queued wire payload", {
          wireChars: pendingPublish.wirePayload.length,
          sentCount: result.sentCount,
          excludeDeviceId: pendingPublish.excludeDeviceId,
          remainingQueueDepth: this.pendingWirePayloads.length,
        });

        await delay(RELAY_PUBLISH_DELAY_MS);
      }
    } finally {
      this.isPublishing = false;
    }
  }

  private async refreshConnectedPeerCount(): Promise<void> {
    const previousCount = this.connectedPeerCount;
    this.connectedPeerCount = await BleBroadcast.getConnectedPeerCountAsync();

    if (previousCount !== this.connectedPeerCount) {
      meshLog("link", "Connected peer count changed", {
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
