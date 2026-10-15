import type { useMesh } from "@shotgunlive/mesh";

export type ChatMessage = {
  id: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  senderId: string;
};

export type ChatWireMessage = {
  type: "chat";
  text: string;
};

type MeshState = ReturnType<typeof useMesh>;
export type MeshPeer = MeshState["peers"][number];
export type MeshStatus = MeshState["status"];
