import {
    base64ToBytes,
    bytesToBase64,
    readUint16BE,
    readUint32BE,
    truncateUtf8ToBytes,
    uuidBytesToString,
    uuidStringToBytes,
    writeUint16BE,
    writeUint32BE,
} from "./bytes";
import { MAX_WIRE_BYTES } from "./constants";
import type { MeshSessionPacket, SessionPacketType } from "./sessionTypes";

export const WIRE_MAGIC = 0x534d; // 'SM'
export const WIRE_VERSION = 1;

export const WIRE_FLAG_HAS_RECIPIENT = 0x01;

export const WIRE_TYPE_IDENTITY = 1;
export const WIRE_TYPE_MESSAGE = 2;
export const WIRE_TYPE_FRAGMENT_START = 3;
export const WIRE_TYPE_FRAGMENT_CONTINUE = 4;
export const WIRE_TYPE_FRAGMENT_END = 5;

const HEADER_SIZE = 42;
const RECIPIENT_SIZE = 16;
const PAYLOAD_LENGTH_SIZE = 2;

const FRAGMENT_CONTINUE_HEADER_SIZE = 18; // transferId + fragmentIndex
const FRAGMENT_START_HEADER_SIZE = 40; // transferId + messageId + counts + index

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function wireTypeFromPacketType(packetType: SessionPacketType): number {
  switch (packetType) {
    case "identity":
      return WIRE_TYPE_IDENTITY;
    case "message":
      return WIRE_TYPE_MESSAGE;
    case "fragmentStart":
      return WIRE_TYPE_FRAGMENT_START;
    case "fragmentContinue":
      return WIRE_TYPE_FRAGMENT_CONTINUE;
    case "fragmentEnd":
      return WIRE_TYPE_FRAGMENT_END;
  }
}

function packetTypeFromWireType(wireType: number): SessionPacketType | null {
  switch (wireType) {
    case WIRE_TYPE_IDENTITY:
      return "identity";
    case WIRE_TYPE_MESSAGE:
      return "message";
    case WIRE_TYPE_FRAGMENT_START:
      return "fragmentStart";
    case WIRE_TYPE_FRAGMENT_CONTINUE:
      return "fragmentContinue";
    case WIRE_TYPE_FRAGMENT_END:
      return "fragmentEnd";
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
  const senderBytes = uuidStringToBytes(packet.senderId);
  const packetIdBytes = uuidStringToBytes(packet.id);
  if (!senderBytes || !packetIdBytes) {
    throw new Error("Invalid UUID in mesh packet header");
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
  offset += 16;

  if (packet.recipientId) {
    const recipientBytes = uuidStringToBytes(packet.recipientId);
    if (!recipientBytes) {
      throw new Error("Invalid recipient UUID in mesh packet header");
    }
    flags |= WIRE_FLAG_HAS_RECIPIENT;
    bytes[4] = flags;
    bytes.set(recipientBytes, offset);
    offset += 16;
  }

  writeUint16BE(bytes, offset, payloadLength);
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
    case WIRE_TYPE_MESSAGE: {
      if (!packet.messageId) {
        throw new Error("Message packet missing messageId");
      }
      const messageIdBytes = uuidStringToBytes(packet.messageId);
      if (!messageIdBytes) {
        throw new Error("Invalid messageId UUID");
      }
      const textBytes = textEncoder.encode(packet.text ?? "");
      const payload = new Uint8Array(16 + 2 + textBytes.length);
      payload.set(messageIdBytes, 0);
      writeUint16BE(payload, 16, textBytes.length);
      payload.set(textBytes, 18);
      return payload;
    }
    case WIRE_TYPE_FRAGMENT_START:
    case WIRE_TYPE_FRAGMENT_CONTINUE:
    case WIRE_TYPE_FRAGMENT_END: {
      if (
        !packet.transferId ||
        packet.fragmentIndex === undefined ||
        !packet.chunkBytes
      ) {
        throw new Error("Fragment packet missing required fields");
      }

      const transferBytes = uuidStringToBytes(packet.transferId);
      if (!transferBytes) {
        throw new Error("Invalid transferId UUID");
      }

      if (
        wireType === WIRE_TYPE_FRAGMENT_CONTINUE ||
        wireType === WIRE_TYPE_FRAGMENT_END
      ) {
        const payload = new Uint8Array(
          FRAGMENT_CONTINUE_HEADER_SIZE + packet.chunkBytes.length,
        );
        payload.set(transferBytes, 0);
        writeUint16BE(payload, 16, packet.fragmentIndex);
        payload.set(packet.chunkBytes, 18);
        return payload;
      }

      if (!packet.messageId || !packet.fragmentCount || !packet.totalBytes) {
        throw new Error("Fragment start packet missing required fields");
      }

      const messageIdBytes = uuidStringToBytes(packet.messageId);
      if (!messageIdBytes) {
        throw new Error("Invalid messageId UUID");
      }

      const payload = new Uint8Array(
        FRAGMENT_START_HEADER_SIZE + packet.chunkBytes.length,
      );
      payload.set(transferBytes, 0);
      payload.set(messageIdBytes, 16);
      writeUint16BE(payload, 32, packet.fragmentCount);
      writeUint32BE(payload, 34, packet.totalBytes);
      writeUint16BE(payload, 38, packet.fragmentIndex);
      payload.set(packet.chunkBytes, 40);
      return payload;
    }
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
  const senderId = uuidBytesToString(bytes.slice(offset, offset + 16));
  offset += 16;

  let recipientId: string | null = null;
  if (flags & WIRE_FLAG_HAS_RECIPIENT) {
    if (bytes.length < offset + 16 + PAYLOAD_LENGTH_SIZE) {
      return null;
    }
    recipientId = uuidBytesToString(bytes.slice(offset, offset + 16));
    offset += 16;
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
    case WIRE_TYPE_MESSAGE: {
      if (payload.length < 18) {
        return null;
      }
      const messageId = uuidBytesToString(payload.slice(0, 16));
      const textLength = readUint16BE(payload, 16);
      const text = textDecoder.decode(payload.slice(18, 18 + textLength));
      return { ...base, messageId, text };
    }
    case WIRE_TYPE_FRAGMENT_START:
    case WIRE_TYPE_FRAGMENT_CONTINUE:
    case WIRE_TYPE_FRAGMENT_END: {
      if (wireType === WIRE_TYPE_FRAGMENT_START) {
        if (payload.length < FRAGMENT_START_HEADER_SIZE) {
          return null;
        }
        const transferId = uuidBytesToString(payload.slice(0, 16));
        const messageId = uuidBytesToString(payload.slice(16, 32));
        const fragmentCount = readUint16BE(payload, 32);
        const totalBytes = readUint32BE(payload, 34);
        const fragmentIndex = readUint16BE(payload, 38);
        const chunkBytes = payload.slice(40);
        return {
          ...base,
          transferId,
          messageId,
          fragmentIndex,
          fragmentCount,
          totalBytes,
          chunkBytes,
        };
      }

      if (payload.length < FRAGMENT_CONTINUE_HEADER_SIZE) {
        return null;
      }

      const transferId = uuidBytesToString(payload.slice(0, 16));
      const fragmentIndex = readUint16BE(payload, 16);
      const chunkBytes = payload.slice(18);
      return {
        ...base,
        transferId,
        fragmentIndex,
        chunkBytes,
      };
    }
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
