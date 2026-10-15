import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  readUint16BE,
  readUint32BE,
  truncateUtf8ToBytes,
  uuidBytesToString,
  uuidStringToBytes,
  writeUint16BE,
  writeUint32BE,
} from "./bytes";
import { DEVICE_ID_BYTES, MAX_WIRE_BYTES } from "./constants";
import type {
  MeshItemPart,
  MeshSessionPacket,
  SessionPacketType,
  SyncRange,
} from "./sessionTypes";

export const WIRE_MAGIC = 0x534d; // 'SM'
export const WIRE_VERSION = 1;

export const WIRE_FLAG_HAS_RECIPIENT = 0x01;

export const WIRE_TYPE_IDENTITY = 1;
export const WIRE_TYPE_SYNC_ITEMS = 2;
export const WIRE_TYPE_SYNC_DIGEST = 3;
export const WIRE_TYPE_SYNC_VECTOR = 4;
export const WIRE_TYPE_SYNC_REQUEST = 5;

/** Scope hash at the start of every sync payload. */
const SYNC_SCOPE_BYTES = 4;
/**
 * Per part in a `syncItems` payload: author + seq (4) + createdAt (6, ms) + part index and count
 * (1 + 1) + length (2).
 */
export const SYNC_PART_OVERHEAD_BYTES = DEVICE_ID_BYTES + 4 + 6 + 2 + 2;
const SYNC_VECTOR_ENTRY_BYTES = DEVICE_ID_BYTES + 4;
const SYNC_RANGE_BYTES = DEVICE_ID_BYTES + 8;

// magic (2) + version + type + flags + ttl + timestamp (4) + packet id (16) + sender id
const HEADER_SIZE = 26 + DEVICE_ID_BYTES;
const RECIPIENT_SIZE = DEVICE_ID_BYTES;
const PAYLOAD_LENGTH_SIZE = 2;

const textDecoder = new TextDecoder();

function wireTypeFromPacketType(packetType: SessionPacketType): number {
  switch (packetType) {
    case "identity":
      return WIRE_TYPE_IDENTITY;
    case "syncItems":
      return WIRE_TYPE_SYNC_ITEMS;
    case "syncDigest":
      return WIRE_TYPE_SYNC_DIGEST;
    case "syncVector":
      return WIRE_TYPE_SYNC_VECTOR;
    case "syncRequest":
      return WIRE_TYPE_SYNC_REQUEST;
  }
}

function packetTypeFromWireType(wireType: number): SessionPacketType | null {
  switch (wireType) {
    case WIRE_TYPE_IDENTITY:
      return "identity";
    case WIRE_TYPE_SYNC_ITEMS:
      return "syncItems";
    case WIRE_TYPE_SYNC_DIGEST:
      return "syncDigest";
    case WIRE_TYPE_SYNC_VECTOR:
      return "syncVector";
    case WIRE_TYPE_SYNC_REQUEST:
      return "syncRequest";
    default:
      return null;
  }
}

function headerSize(hasRecipient: boolean): number {
  return (
    HEADER_SIZE + (hasRecipient ? RECIPIENT_SIZE : 0) + PAYLOAD_LENGTH_SIZE
  );
}

function writeHeader(
  bytes: Uint8Array,
  packet: MeshSessionPacket,
  wireType: number,
  payloadLength: number,
): void {
  const senderBytes = hexToBytes(packet.senderId, DEVICE_ID_BYTES);
  const packetIdBytes = uuidStringToBytes(packet.id);
  if (!senderBytes || !packetIdBytes) {
    throw new Error("Invalid sender or packet ID in mesh packet header");
  }

  let flags = 0;
  let offset = 0;
  bytes[offset++] = 0x53;
  bytes[offset++] = 0x4d;
  bytes[offset++] = WIRE_VERSION;
  bytes[offset++] = wireType;
  bytes[offset++] = flags;
  bytes[offset++] = packet.ttl & 0xff;
  writeUint32BE(bytes, offset, Math.floor(packet.ts / 1000));
  offset += 4;
  bytes.set(packetIdBytes, offset);
  offset += 16;
  bytes.set(senderBytes, offset);
  offset += DEVICE_ID_BYTES;

  if (packet.recipientId) {
    const recipientBytes = hexToBytes(packet.recipientId, DEVICE_ID_BYTES);
    if (!recipientBytes) {
      throw new Error("Invalid recipient ID in mesh packet header");
    }
    flags |= WIRE_FLAG_HAS_RECIPIENT;
    bytes[4] = flags;
    bytes.set(recipientBytes, offset);
    offset += RECIPIENT_SIZE;
  }

  writeUint16BE(bytes, offset, payloadLength);
}

function requireDeviceIdBytes(deviceId: string): Uint8Array {
  const bytes = hexToBytes(deviceId, DEVICE_ID_BYTES);
  if (!bytes) {
    throw new Error(`Invalid device ID "${deviceId}" in sync packet`);
  }
  return bytes;
}

/** 48-bit unsigned, big-endian: millisecond timestamps until the year 10889. */
function writeUint48BE(bytes: Uint8Array, offset: number, value: number): void {
  writeUint16BE(bytes, offset, Math.floor(value / 2 ** 32) & 0xffff);
  writeUint32BE(bytes, offset + 2, value >>> 0);
}

function readUint48BE(bytes: Uint8Array, offset: number): number {
  return (
    readUint16BE(bytes, offset) * 2 ** 32 + readUint32BE(bytes, offset + 2)
  );
}

function buildSyncPayloadBytes(
  packet: MeshSessionPacket,
  wireType: number,
): Uint8Array {
  const body = buildSyncBodyBytes(packet, wireType);
  const payload = new Uint8Array(SYNC_SCOPE_BYTES + body.length);
  writeUint32BE(payload, 0, packet.scope ?? 0);
  payload.set(body, SYNC_SCOPE_BYTES);
  return payload;
}

function buildSyncBodyBytes(
  packet: MeshSessionPacket,
  wireType: number,
): Uint8Array {
  switch (wireType) {
    case WIRE_TYPE_SYNC_ITEMS: {
      const parts = packet.parts ?? [];
      if (parts.length > 255) {
        throw new Error("Sync items packet holds at most 255 parts");
      }
      const size = parts.reduce(
        (sum, part) => sum + SYNC_PART_OVERHEAD_BYTES + part.bytes.length,
        1,
      );
      const payload = new Uint8Array(size);
      payload[0] = parts.length;
      let offset = 1;
      for (const part of parts) {
        payload.set(requireDeviceIdBytes(part.author), offset);
        offset += DEVICE_ID_BYTES;
        writeUint32BE(payload, offset, part.seq);
        writeUint48BE(
          payload,
          offset + 4,
          Math.max(0, Math.floor(part.createdAt)),
        );
        payload[offset + 10] = part.partIndex;
        payload[offset + 11] = part.partCount;
        writeUint16BE(payload, offset + 12, part.bytes.length);
        offset += 14;
        payload.set(part.bytes, offset);
        offset += part.bytes.length;
      }
      return payload;
    }
    case WIRE_TYPE_SYNC_DIGEST: {
      const payload = new Uint8Array(8);
      writeUint32BE(payload, 0, packet.digest?.xor ?? 0);
      writeUint32BE(payload, 4, packet.digest?.count ?? 0);
      return payload;
    }
    case WIRE_TYPE_SYNC_VECTOR: {
      const entries = packet.vector ?? [];
      const payload = new Uint8Array(
        1 + entries.length * SYNC_VECTOR_ENTRY_BYTES,
      );
      payload[0] = entries.length;
      entries.forEach(([author, seq], index) => {
        const offset = 1 + index * SYNC_VECTOR_ENTRY_BYTES;
        payload.set(requireDeviceIdBytes(author), offset);
        writeUint32BE(payload, offset + DEVICE_ID_BYTES, seq);
      });
      return payload;
    }
    case WIRE_TYPE_SYNC_REQUEST: {
      const ranges = packet.ranges ?? [];
      const payload = new Uint8Array(1 + ranges.length * SYNC_RANGE_BYTES);
      payload[0] = ranges.length;
      ranges.forEach(([author, fromSeq, toSeq], index) => {
        const offset = 1 + index * SYNC_RANGE_BYTES;
        payload.set(requireDeviceIdBytes(author), offset);
        writeUint32BE(payload, offset + DEVICE_ID_BYTES, fromSeq);
        writeUint32BE(payload, offset + DEVICE_ID_BYTES + 4, toSeq);
      });
      return payload;
    }
    default:
      throw new Error(`Unsupported sync packet type ${wireType}`);
  }
}

function decodeSyncPayload(
  base: MeshSessionPacket,
  wireType: number,
  payload: Uint8Array,
): MeshSessionPacket | null {
  if (payload.length < SYNC_SCOPE_BYTES) {
    return null;
  }
  return decodeSyncBody(
    { ...base, scope: readUint32BE(payload, 0) },
    wireType,
    payload.slice(SYNC_SCOPE_BYTES),
  );
}

function decodeSyncBody(
  base: MeshSessionPacket,
  wireType: number,
  payload: Uint8Array,
): MeshSessionPacket | null {
  if (payload.length < 1 && wireType !== WIRE_TYPE_SYNC_DIGEST) {
    return null;
  }
  switch (wireType) {
    case WIRE_TYPE_SYNC_ITEMS: {
      const parts: MeshItemPart[] = [];
      let offset = 1;
      for (let index = 0; index < payload[0]!; index += 1) {
        if (payload.length < offset + SYNC_PART_OVERHEAD_BYTES) {
          return null;
        }
        const author = bytesToHex(
          payload.slice(offset, offset + DEVICE_ID_BYTES),
        );
        offset += DEVICE_ID_BYTES;
        const seq = readUint32BE(payload, offset);
        const createdAt = readUint48BE(payload, offset + 4);
        const partIndex = payload[offset + 10]!;
        const partCount = payload[offset + 11]!;
        const length = readUint16BE(payload, offset + 12);
        offset += 14;
        if (payload.length < offset + length || partIndex >= partCount) {
          return null;
        }
        parts.push({
          author,
          seq,
          createdAt,
          partIndex,
          partCount,
          bytes: payload.slice(offset, offset + length),
        });
        offset += length;
      }
      return { ...base, parts };
    }
    case WIRE_TYPE_SYNC_DIGEST: {
      if (payload.length < 8) {
        return null;
      }
      return {
        ...base,
        digest: {
          xor: readUint32BE(payload, 0),
          count: readUint32BE(payload, 4),
        },
      };
    }
    case WIRE_TYPE_SYNC_VECTOR: {
      const count = payload[0]!;
      if (payload.length < 1 + count * SYNC_VECTOR_ENTRY_BYTES) {
        return null;
      }
      const vector: [string, number][] = [];
      for (let index = 0; index < count; index += 1) {
        const offset = 1 + index * SYNC_VECTOR_ENTRY_BYTES;
        vector.push([
          bytesToHex(payload.slice(offset, offset + DEVICE_ID_BYTES)),
          readUint32BE(payload, offset + DEVICE_ID_BYTES),
        ]);
      }
      return { ...base, vector };
    }
    case WIRE_TYPE_SYNC_REQUEST: {
      const count = payload[0]!;
      if (payload.length < 1 + count * SYNC_RANGE_BYTES) {
        return null;
      }
      const ranges: SyncRange[] = [];
      for (let index = 0; index < count; index += 1) {
        const offset = 1 + index * SYNC_RANGE_BYTES;
        ranges.push([
          bytesToHex(payload.slice(offset, offset + DEVICE_ID_BYTES)),
          readUint32BE(payload, offset + DEVICE_ID_BYTES),
          readUint32BE(payload, offset + DEVICE_ID_BYTES + 4),
        ]);
      }
      return { ...base, ranges };
    }
    default:
      return null;
  }
}

function buildPayloadBytes(
  packet: MeshSessionPacket,
  wireType: number,
): Uint8Array {
  switch (wireType) {
    case WIRE_TYPE_IDENTITY: {
      const nameBytes = truncateUtf8ToBytes(packet.displayName ?? "", 255);
      const payload = new Uint8Array(1 + nameBytes.length);
      payload[0] = nameBytes.length;
      payload.set(nameBytes, 1);
      return payload;
    }
    case WIRE_TYPE_SYNC_ITEMS:
    case WIRE_TYPE_SYNC_DIGEST:
    case WIRE_TYPE_SYNC_VECTOR:
    case WIRE_TYPE_SYNC_REQUEST:
      return buildSyncPayloadBytes(packet, wireType);
    default:
      throw new Error(`Unsupported wire packet type ${wireType}`);
  }
}

export function encodeBinaryWirePacket(packet: MeshSessionPacket): Uint8Array {
  const wireType = wireTypeFromPacketType(packet.packetType);
  const payloadBytes = buildPayloadBytes(packet, wireType);
  const totalSize =
    headerSize(Boolean(packet.recipientId)) + payloadBytes.length;

  if (totalSize > MAX_WIRE_BYTES) {
    throw new Error(
      `Wire packet exceeds the ${MAX_WIRE_BYTES}-byte mesh limit (${totalSize} bytes).`,
    );
  }

  const bytes = new Uint8Array(totalSize);
  writeHeader(bytes, packet, wireType, payloadBytes.length);
  bytes.set(payloadBytes, headerSize(Boolean(packet.recipientId)));
  return bytes;
}

export function encodeBinaryWireBase64(packet: MeshSessionPacket): string {
  return bytesToBase64(encodeBinaryWirePacket(packet));
}

export function isBinaryWireBase64(wirePayload: string): boolean {
  const bytes = base64ToBytes(wirePayload);
  return (
    bytes !== null &&
    bytes.length >= 2 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x4d &&
    bytes[2] === WIRE_VERSION
  );
}

export function decodeBinaryWirePacket(
  bytes: Uint8Array,
): MeshSessionPacket | null {
  if (
    bytes.length < HEADER_SIZE + PAYLOAD_LENGTH_SIZE ||
    bytes[0] !== 0x53 ||
    bytes[1] !== 0x4d ||
    bytes[2] !== WIRE_VERSION
  ) {
    return null;
  }

  const wireType = bytes[3]!;
  const packetType = packetTypeFromWireType(wireType);
  if (!packetType) {
    return null;
  }

  const flags = bytes[4]!;
  const ttl = bytes[5]!;
  const timestampSeconds = readUint32BE(bytes, 6);
  let offset = 10;
  const packetId = uuidBytesToString(bytes.slice(offset, offset + 16));
  offset += 16;
  const senderId = bytesToHex(bytes.slice(offset, offset + DEVICE_ID_BYTES));
  offset += DEVICE_ID_BYTES;

  let recipientId: string | null = null;
  if (flags & WIRE_FLAG_HAS_RECIPIENT) {
    if (bytes.length < offset + RECIPIENT_SIZE + PAYLOAD_LENGTH_SIZE) {
      return null;
    }
    recipientId = bytesToHex(bytes.slice(offset, offset + RECIPIENT_SIZE));
    offset += RECIPIENT_SIZE;
  }

  if (bytes.length < offset + PAYLOAD_LENGTH_SIZE) {
    return null;
  }

  const payloadLength = readUint16BE(bytes, offset);
  offset += 2;
  if (bytes.length < offset + payloadLength) {
    return null;
  }

  const payload = bytes.slice(offset, offset + payloadLength);
  const base: MeshSessionPacket = {
    type: "mesh.session",
    packetType,
    id: packetId,
    senderId,
    recipientId,
    ttl,
    ts: timestampSeconds * 1000,
  };

  switch (wireType) {
    case WIRE_TYPE_IDENTITY: {
      if (payload.length < 1) {
        return null;
      }
      const nameLength = payload[0]!;
      const displayName = textDecoder.decode(payload.slice(1, 1 + nameLength));
      return { ...base, displayName };
    }
    case WIRE_TYPE_SYNC_ITEMS:
    case WIRE_TYPE_SYNC_DIGEST:
    case WIRE_TYPE_SYNC_VECTOR:
    case WIRE_TYPE_SYNC_REQUEST:
      return decodeSyncPayload(base, wireType, payload);
    default:
      return null;
  }
}

export function decodeBinaryWireBase64(
  wirePayload: string,
): MeshSessionPacket | null {
  const bytes = base64ToBytes(wirePayload);
  if (!bytes) {
    return null;
  }
  return decodeBinaryWirePacket(bytes);
}

export function binaryWireByteLength(packet: MeshSessionPacket): number {
  return encodeBinaryWirePacket(packet).length;
}
