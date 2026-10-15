import type { MeshItem } from "../sync/types";

export type { MeshStatus } from "../mesh/lifecycle";

export type MeshPeer = {
  /** The peer's device ID: generated once per install, so it survives app restarts and Bluetooth toggles. */
  id: string;
  /**
   * Human-readable name: what the peer announces (its device name unless the app set one, e.g.
   * "Galaxy A22 5G"), else its Bluetooth name, else its short ID.
   */
  displayName: string;
  /** The peer's Bluetooth name, when this device connected to it directly. */
  deviceName: string | null;
  /** Signal strength of the direct link in dBm, or null when the peer is only reached through others. */
  rssi: number | null;
  /** When this device last heard from or about the peer (ms since epoch). */
  lastSeen: number;
};

/** Items this device did not have yet, received from peers (never its own), already saved. */
export type MeshItemsListener = (items: MeshItem[]) => void;
