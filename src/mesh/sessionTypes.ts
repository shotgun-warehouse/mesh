/** One part of a synced item: items over one packet travel as several parts. */
export type MeshItemPart = {
  author: string;
  seq: number;
  createdAt: number;
  partIndex: number;
  partCount: number;
  /** This part's slice of the item's UTF-8 data. */
  bytes: Uint8Array;
};

export type SessionPacketType =
  "identity" | "syncItems" | "syncDigest" | "syncVector" | "syncRequest";

/** `[author, fromSeq, toSeq]`, inclusive. */
export type SyncRange = [string, number, number];

export type MeshSessionPacket = {
  type: "mesh.session";
  packetType: SessionPacketType;
  /** Unique ID for gossip dedup — preserved across relay hops. */
  id: string;
  senderId: string;
  /** `null` means broadcast to all peers. */
  recipientId: string | null;
  ttl: number;
  ts: number;
  /** `identity`: the name the sender announces. */
  displayName?: string;
  /** Sync packets: hash of the sync scope; devices ignore other scopes. */
  scope?: number;
  /** `syncItems`: item parts, flooded when fresh or sent to one neighbour on request. */
  parts?: MeshItemPart[];
  /** `syncDigest`: XOR of item hashes and item count, so equal sets compare equal. */
  digest?: { xor: number; count: number };
  /** `syncVector`: `[author, highest contiguous seq]` entries. */
  vector?: [string, number][];
  /** `syncRequest`: ranges the sender misses. */
  ranges?: SyncRange[];
};
