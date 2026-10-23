import type { useMesh } from "@shotgunlive/mesh";

/** A photo split over several synced items, as received so far. */
export type ImageTransfer = {
  imageId: string;
  count: number;
  width: number;
  height: number;
  /** JPEG size in bytes. */
  bytes: number;
  checksum: string;
  /** When the sender started publishing (its clock). */
  sentAt: number;
  /** Base64 data by chunk index; null until that chunk arrives. */
  chunks: (string | null)[];
  receivedCount: number;
  /** This device's clock, for the first and the last chunk. */
  firstReceivedAt: number;
  completedAt: number | null;
  /** The whole JPEG once every chunk is in. */
  base64: string | null;
  /** Whether the reassembled image matches the sender's checksum; null until complete. */
  isIntact: boolean | null;
};

type ChatMessageBase = {
  id: string;
  timestamp: number;
  outgoing: boolean;
  senderId: string;
};

export type ChatMessage =
  | (ChatMessageBase & { kind: "text"; text: string })
  | (ChatMessageBase & { kind: "image"; image: ImageTransfer });

export type ChatTextWireMessage = {
  type: "chat";
  text: string;
};

/** One chunk of a photo; each is its own synced item. */
export type ImageChunkWireMessage = {
  type: "image";
  imageId: string;
  index: number;
  count: number;
  width: number;
  height: number;
  bytes: number;
  checksum: string;
  sentAt: number;
  data: string;
};

export type ChatWireMessage = ChatTextWireMessage | ImageChunkWireMessage;

type MeshState = ReturnType<typeof useMesh>;
export type MeshPeer = MeshState["peers"][number];
export type MeshStatus = MeshState["status"];
