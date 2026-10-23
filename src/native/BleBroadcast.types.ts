export type BroadcastResult = {
  totalBytes: number;
  advertisedBytes: number;
  truncated: boolean;
};

export type ReceivedMessage = {
  deviceId: string;
  /** BLE link the packet arrived on — used to exclude the sender when gossip-relaying. */
  viaDeviceId: string;
  deviceName: string | null;
  /** Base64-encoded compact binary mesh wire packet (`SM` format). */
  jsonMessage: string;
  rssi: number;
  truncated: boolean;
  source: "connection" | "gatt" | "advertisement";
  timestamp: number;
};

/**
 * `outbound`: this device connected to the peer and writes to it. `inbound`: the peer connected to
 * this device and subscribed to its notifications, so this device can send to it even before (or
 * without) its own link to the peer. A peer is usually linked both ways; it is sent each packet
 * once.
 */
export type LinkDirection = "outbound" | "inbound";

export type PeerConnectionEvent = {
  /**
   * BLE link identifier (not stable: one phone can appear under several). Unique per direction
   * only: an outbound and an inbound link can share it.
   */
  deviceId: string;
  /**
   * The peer's mesh device ID: from its advertisement or read from the peer before the link is
   * ready (outbound), or from the hello the peer writes before subscribing (inbound). Null when
   * none gave it; the event comes again once it is known.
   */
  meshId: string | null;
  deviceName: string | null;
  /** From the link's advertisement (outbound), else the last advertisement seen for `meshId`. */
  rssi: number | null;
  direction: LinkDirection;
};

export type PeerDisconnectionEvent = {
  deviceId: string;
  meshId: string | null;
  direction: LinkDirection;
};

export type SendPacketResult = {
  sentCount: number;
  readyPeerCount: number;
  skippedExcluded: number;
};

export type MeshLogLevel = "debug" | "info" | "warn" | "error";

export type MeshLogEvent = {
  platform: "android" | "ios";
  tag: string;
  level: MeshLogLevel;
  message: string;
  detail?: string;
};

/**
 * Bluetooth availability as seen by the native module, named after CoreBluetooth's `CBManagerState`.
 * `unauthorized` covers denied and restricted permissions; `unknown` is transient (the OS is still
 * initializing, waiting for the user to answer the permission prompt, or turning Bluetooth on) and
 * is always followed by an `onBluetoothStateChange` event.
 */
export type BluetoothState =
  "poweredOn" | "poweredOff" | "unauthorized" | "unsupported" | "unknown";

export type BluetoothStateChangeEvent = {
  state: BluetoothState;
};

export type BleBroadcastModuleEvents = {
  onMessageReceived: (event: ReceivedMessage) => void;
  onPeerConnected: (event: PeerConnectionEvent) => void;
  onPeerDisconnected: (event: PeerDisconnectionEvent) => void;
  onMeshLog: (event: MeshLogEvent) => void;
  onBluetoothStateChange: (event: BluetoothStateChangeEvent) => void;
};

export const BLE_SERVICE_UUID = "0000feed-0000-1000-8000-00805f9b34fb";
export const BLE_CHARACTERISTIC_UUID = "0000beef-0000-1000-8000-00805f9b34fb";
export const MAX_GATT_PAYLOAD_BYTES = 4096;
