import { createContext } from "react";

import type { MeshMessageListener, MeshPeer, MeshStatus } from "./types";

export type MeshContextValue = {
  /** Where the mesh is in its lifecycle. `broadcast` only works while this is `"running"`. */
  status: MeshStatus;
  /** Why the last start attempts failed, when `status` is `"error"`; otherwise null. */
  error: string | null;
  /** This device's ID, generated once per install. Peers see it as `peer.id`. */
  deviceId: string;
  /** The name nearby peers see for this device. */
  displayName: string;
  /** Renames this device on the mesh; peers see the new name within seconds. Blank names are ignored. */
  setDisplayName: (displayName: string) => void;
  /**
   * Devices on the mesh, most recently active first. A peer is removed when its last direct link
   * drops; peers reached only through others stay until the mesh stops.
   */
  peers: MeshPeer[];
  connectedPeerCount: number;
  /**
   * Sends a JSON string to every peer. Rejects with `MeshNotRunningError` unless `status` is
   * `"running"`; resolves once the packets are handed to the radio (or queued until a peer links).
   */
  broadcast: (json: string) => Promise<void>;
  /** A peer by its device ID. */
  getPeer: (peerId: string) => MeshPeer | undefined;
};

export const MeshContext = createContext<MeshContextValue | null>(null);

export type MeshMessageSubscribe = (
  listener: MeshMessageListener,
) => () => void;

export const MeshMessagesContext = createContext<MeshMessageSubscribe | null>(
  null,
);
