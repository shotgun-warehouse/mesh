import {
  binaryWireByteLength,
  decodeBinaryWireBase64,
  encodeBinaryWireBase64,
  isBinaryWireBase64,
} from "./binaryWire";
import { createUuid } from "./ids";
import { IDENTITY_TTL, MAX_WIRE_BYTES } from "./constants";
import type {
  MeshItemPart,
  MeshSessionPacket,
  SessionPacketType,
  SyncRange,
} from "./sessionTypes";

export type { MeshItemPart, MeshSessionPacket, SessionPacketType, SyncRange };

export function createPacketId(): string {
  return createUuid();
}

export function encodeWirePacket(packet: MeshSessionPacket): string {
  return encodeBinaryWireBase64(packet);
}

export function decodeWirePacket(
  wirePayload: string,
): MeshSessionPacket | null {
  if (!isBinaryWireBase64(wirePayload)) {
    return null;
  }
  return decodeBinaryWireBase64(wirePayload);
}

export function wirePacketByteLength(packet: MeshSessionPacket): number {
  return binaryWireByteLength(packet);
}

function safeWirePacketByteLength(packet: MeshSessionPacket): number {
  try {
    return wirePacketByteLength(packet);
  } catch {
    return MAX_WIRE_BYTES + 1;
  }
}

export function buildIdentityPacket(
  senderId: string,
  displayName: string,
  packetId: string = createPacketId(),
): MeshSessionPacket {
  return {
    type: "mesh.session",
    packetType: "identity",
    id: packetId,
    senderId,
    recipientId: null,
    ttl: IDENTITY_TTL,
    ts: Date.now(),
    displayName,
  };
}

export function isSyncPacketType(packetType: SessionPacketType): boolean {
  return (
    packetType === "syncItems" ||
    packetType === "syncDigest" ||
    packetType === "syncVector" ||
    packetType === "syncRequest"
  );
}

/**
 * A sync packet. `ttl` 0 keeps it on direct links (never relayed); `recipientId` addresses it to
 * one neighbour (others ignore it).
 */
export function buildSyncPacket(
  senderId: string,
  packetType: "syncItems" | "syncDigest" | "syncVector" | "syncRequest",
  scope: number,
  body: {
    parts?: MeshItemPart[];
    digest?: { xor: number; count: number };
    vector?: [string, number][];
    ranges?: SyncRange[];
  },
  ttl: number,
  recipientId: string | null,
): MeshSessionPacket {
  return {
    type: "mesh.session",
    packetType,
    id: createPacketId(),
    senderId,
    recipientId,
    ttl,
    ts: Date.now(),
    scope,
    ...body,
  };
}

export function fitsOneWrite(packet: MeshSessionPacket): boolean {
  return safeWirePacketByteLength(packet) <= MAX_WIRE_BYTES;
}

export function buildRelayPacket(
  packet: MeshSessionPacket,
): MeshSessionPacket | null {
  if (packet.ttl <= 0) {
    return null;
  }

  return {
    ...packet,
    ttl: packet.ttl - 1,
  };
}
