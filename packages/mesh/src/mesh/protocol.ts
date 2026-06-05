import { createClientId } from "./clientId";
import {
  buildIdentityPacket,
  buildMessageWirePackets,
  decodeAnyWirePacket,
  encodeWirePacket,
} from "./packets";
import type { MeshPresence } from "./types";

export function buildIdentityPayload(
  clientId: string,
  displayName: string,
): string {
  return encodeWirePacket(buildIdentityPacket(clientId, displayName));
}

export function buildChatPayload(
  clientId: string,
  displayName: string,
  text: string,
  toClientId: string,
  messageId: string = createClientId(),
): { payload: string; messageId: string } {
  const packets = buildMessageWirePackets(
    clientId,
    displayName,
    text,
    toClientId,
    messageId,
  );

  return { payload: encodeWirePacket(packets[0]!), messageId };
}

export function parseMeshPayload(wirePayload: string): MeshPresence | null {
  const packet = decodeAnyWirePacket(wirePayload);
  if (!packet) {
    return null;
  }

  return {
    type: "mesh.presence",
    clientId: packet.senderId,
    displayName: packet.displayName,
    toClientId: packet.recipientId ?? undefined,
    messageId: packet.messageId,
    text: packet.text,
    ts: packet.ts,
  };
}
