import { createContext } from "react";

import type { MeshPeer, MeshStartOptions, MeshStatus } from "./types";

export type MeshContextValue = {
  status: MeshStatus;
  isReady: boolean;
  error: string | null;
  clientId: string | null;
  displayName: string | null;
  connectedPeerCount: number;
  peers: MeshPeer[];
  start: (options: MeshStartOptions) => Promise<void>;
  stop: () => Promise<void>;
  broadcast: (json: string) => Promise<void>;
  getPeer: (peerId: string) => MeshPeer | undefined;
};

export const MeshContext = createContext<MeshContextValue | null>(null);
