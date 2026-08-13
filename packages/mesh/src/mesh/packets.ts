import {
    binaryWireByteLength,
    decodeBinaryWireBase64,
    encodeBinaryWireBase64,
    isBinaryWireBase64,
} from "./binaryWire";
import { createClientId } from "./clientId";
import {
    DEFAULT_TTL,
    IDENTITY_TTL,
    INITIAL_FRAGMENT_CHUNK_BYTES,
    MAX_WIRE_BYTES,
    MAX_WIRE_FIT_BYTES,
} from "./constants";
import type { MeshSessionPacket, SessionPacketType } from "./sessionTypes";

export type { MeshSessionPacket, SessionPacketType };

export function createPacketId(): string {
  return createClientId();
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

function fitsOnWire(packet: MeshSessionPacket): boolean {
  return safeWirePacketByteLength(packet) <= MAX_WIRE_FIT_BYTES;
}

function exceedsWireLimit(packet: MeshSessionPacket): boolean {
  return safeWirePacketByteLength(packet) > MAX_WIRE_BYTES;
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

export function buildMessagePacket(
  senderId: string,
  displayName: string,
  text: string,
  recipientId: string | null,
  messageId: string = createPacketId(),
  ttl: number = DEFAULT_TTL,
  packetId: string = createPacketId(),
): MeshSessionPacket {
  return {
    type: "mesh.session",
    packetType: "message",
    id: packetId,
    senderId,
    recipientId,
    ttl,
    ts: Date.now(),
    displayName,
    messageId,
    text,
  };
}

function buildFragmentPacketType(
  fragmentIndex: number,
  fragmentCount: number,
): SessionPacketType {
  if (fragmentIndex === 0) {
    return "fragmentStart";
  }

  if (fragmentIndex === fragmentCount - 1) {
    return "fragmentEnd";
  }

  return "fragmentContinue";
}

function splitBytes(payload: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function buildFragmentPacket(
  byteChunk: Uint8Array,
  fragmentIndex: number,
  fragmentCount: number,
  senderId: string,
  recipientId: string | null,
  messageId: string,
  transferId: string,
  totalBytes: number,
  packetId: string,
): MeshSessionPacket {
  return {
    type: "mesh.session",
    packetType: buildFragmentPacketType(fragmentIndex, fragmentCount),
    id: packetId,
    senderId,
    recipientId,
    ttl: DEFAULT_TTL,
    ts: Date.now(),
    messageId,
    transferId,
    fragmentIndex,
    fragmentCount,
    totalBytes,
    chunkBytes: byteChunk,
  };
}

function buildFragmentCandidatePackets(
  textBytes: Uint8Array,
  chunkSize: number,
  senderId: string,
  recipientId: string | null,
  messageId: string,
  transferId: string,
  packetIds: string[],
): MeshSessionPacket[] {
  const byteChunks = splitBytes(textBytes, chunkSize);

  return byteChunks.map((byteChunk, fragmentIndex) =>
    buildFragmentPacket(
      byteChunk,
      fragmentIndex,
      byteChunks.length,
      senderId,
      recipientId,
      messageId,
      transferId,
      textBytes.length,
      packetIds[fragmentIndex]!,
    ),
  );
}

function findLargestFittingChunkSize(
  textBytes: Uint8Array,
  senderId: string,
  recipientId: string | null,
  messageId: string,
  transferId: string,
  packetIds: string[],
): number | null {
  let low = 1;
  let high = Math.min(INITIAL_FRAGMENT_CHUNK_BYTES, textBytes.length);
  let bestChunkSize: number | null = null;

  while (low <= high) {
    const chunkSize = Math.floor((low + high) / 2);
    const candidatePackets = buildFragmentCandidatePackets(
      textBytes,
      chunkSize,
      senderId,
      recipientId,
      messageId,
      transferId,
      packetIds,
    );

    if (candidatePackets.every(fitsOnWire)) {
      bestChunkSize = chunkSize;
      low = chunkSize + 1;
    } else {
      high = chunkSize - 1;
    }
  }

  return bestChunkSize;
}

export function buildMessageWirePackets(
  senderId: string,
  displayName: string,
  text: string,
  recipientId: string | null,
  messageId: string = createPacketId(),
): MeshSessionPacket[] {
  const singlePacket = buildMessagePacket(
    senderId,
    displayName,
    text,
    recipientId,
    messageId,
  );

  if (fitsOnWire(singlePacket)) {
    return [singlePacket];
  }

  const textBytes = new TextEncoder().encode(text);
  const transferId = createPacketId();
  const packetIds = Array.from({ length: textBytes.length }, () =>
    createPacketId(),
  );
  let chunkSize = findLargestFittingChunkSize(
    textBytes,
    senderId,
    recipientId,
    messageId,
    transferId,
    packetIds,
  );

  if (chunkSize === null) {
    throw new Error(
      `Unable to fragment message into packets that fit the ${MAX_WIRE_BYTES}-byte wire limit.`,
    );
  }

  let packets = buildFragmentCandidatePackets(
    textBytes,
    chunkSize,
    senderId,
    recipientId,
    messageId,
    transferId,
    packetIds,
  );

  while (packets.some(exceedsWireLimit)) {
    chunkSize -= 1;
    if (chunkSize < 1) {
      throw new Error(
        `Unable to fragment message into packets that fit the ${MAX_WIRE_BYTES}-byte wire limit.`,
      );
    }
    packets = buildFragmentCandidatePackets(
      textBytes,
      chunkSize,
      senderId,
      recipientId,
      messageId,
      transferId,
      packetIds,
    );
  }

  return packets;
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

