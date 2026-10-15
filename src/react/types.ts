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

export type MeshInboundMessage = {
  /** Unique message ID, the same on every device that receives the message. */
  id: string;
  json: string;
  /** Device ID of the sender; `getPeer(senderId)` gives its name. */
  senderId: string;
  /** When the sender sent it (ms since epoch, second precision). */
  timestamp: number;
};

export type MeshMessageListener = (message: MeshInboundMessage) => void;
