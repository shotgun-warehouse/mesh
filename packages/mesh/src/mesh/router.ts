import BleBroadcast, { type ReceivedMessage } from "../../modules/ble-broadcast";
import {
    FRAGMENT_PUBLISH_DELAY_MS,
    IDENTITY_BEACON_INTERVAL_MS,
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
  deviceName: string | null;
  rssi: number;
};

export type MeshRouterCallbacks = {
  onIdentity: (event: MeshIdentityEvent) => void;
  onChatMessage: (event: MeshChatEvent) => void;
  onLinkConnected?: (event: MeshLinkEvent) => void;
  onPeerCountChange?: (connectedPeerCount: number) => void;
  onRelay?: (packetId: string, ttl: number) => void;
};

type PendingWirePublish = {
  wirePayload: string;
  excludeDeviceId: string | null;
};

function shouldQueueUnsentWirePayload(
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
  private readonly identityPacketId = createPacketId();

  constructor(
    private readonly localClientId: string,
    private readonly localDisplayName: string,
    private readonly callbacks: MeshRouterCallbacks,
  ) {}

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
        void this.handlePeerLinkConnected(linkEvent);
      },
    );

    this.peerDisconnectedSubscription = BleBroadcast.addListener(
      "onPeerDisconnected",
      () => {
        void this.refreshConnectedPeerCount();
      },
    );

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    this.identityTimer = setInterval(() => {
      void this.publishIdentityBeacon();
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
        void this.flushPendingWirePayloads();
      }
    }
  }

  private shouldAllowOutboundBackgroundTraffic(): boolean {
    return (
      this.outboundTransferDepth === 0 &&
      !this.fragmentAssembler.hasActiveTransfers()
    );
  }

  private async handlePeerLinkConnected(linkEvent: {
    deviceId: string;
    deviceName: string | null;
    rssi: number;
  }): Promise<void> {
    meshLog("link", "Peer link connected", {
      bleDeviceId: linkEvent.deviceId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
    });

    this.callbacks.onLinkConnected?.({
      bleDeviceId: linkEvent.deviceId,
      deviceName: linkEvent.deviceName,
      rssi: linkEvent.rssi,
    });

    await this.refreshConnectedPeerCount();
    await this.publishIdentityBeacon();
    await this.flushPendingWirePayloads();
  }

  private async publishIdentityBeacon(): Promise<void> {
    if (!this.shouldAllowOutboundBackgroundTraffic()) {
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
        void this.flushPendingWirePayloads();
      }
      return;
    }

    void this.flushPendingWirePayloads();

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
    void this.publishPacket(relayPacket, excludeDeviceId);
  }

  private async publishPacket(
    packet: MeshSessionPacket,
    excludeDeviceId: string | null = null,
  ): Promise<void> {
    await this.publishWire(encodeWirePacket(packet), excludeDeviceId);
  }

  private async publishWire(
    wirePayload: string,
    excludeDeviceId: string | null = null,
  ): Promise<void> {
    if (this.isPublishing) {
      meshLog("queue", "Queued wire payload — publish in progress", {
        wireChars: wirePayload.length,
        excludeDeviceId,
        queueDepth: this.pendingWirePayloads.length + 1,
      });
      this.pendingWirePayloads.push({ wirePayload, excludeDeviceId });
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

      if (shouldQueueUnsentWirePayload(result, this.connectedPeerCount)) {
        meshLog(
          "queue",
          "Queued wire payload — no peers accepted write",
          {
            wireChars: wirePayload.length,
            excludeDeviceId,
            queueDepth: this.pendingWirePayloads.length + 1,
          },
          "warn",
        );
        this.pendingWirePayloads.push({ wirePayload, excludeDeviceId });
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
      void this.flushPendingWirePayloads();
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

        if (shouldQueueUnsentWirePayload(result, this.connectedPeerCount)) {
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
