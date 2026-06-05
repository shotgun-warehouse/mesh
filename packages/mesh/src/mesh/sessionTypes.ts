export type SessionPacketType =
  | "identity"
  | "message"
  | "fragmentStart"
  | "fragmentContinue"
  | "fragmentEnd";

export type MeshSessionPacket = {
  type: "mesh.session";
  v: 1;
  packetType: SessionPacketType;
  /** Unique ID for gossip dedup — preserved across relay hops. */
  id: string;
  senderId: string;
  /** `null` means broadcast to all peers. */
  recipientId: string | null;
  ttl: number;
  ts: number;
  displayName?: string;
  messageId?: string;
  text?: string;
  transferId?: string;
  fragmentIndex?: number;
  fragmentCount?: number;
  totalBytes?: number;
  chunkBytes?: Uint8Array;
};
