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
  /** Base64-encoded compact binary mesh wire packet (v2 `SM` format). */
  jsonMessage: string;
  rssi: number;
  truncated: boolean;
  source: "connection" | "gatt" | "advertisement";
  timestamp: number;
};

export type PeerConnectionEvent = {
  deviceId: string;
  deviceName: string | null;
  rssi: number;
};

export type PeerDisconnectionEvent = {
  deviceId: string;
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

export type BleBroadcastModuleEvents = {
  onMessageReceived: (event: ReceivedMessage) => void;
  onPeerConnected: (event: PeerConnectionEvent) => void;
  onPeerDisconnected: (event: PeerDisconnectionEvent) => void;
  onMeshLog: (event: MeshLogEvent) => void;
};

export const BLE_SERVICE_UUID = "0000feed-0000-1000-8000-00805f9b34fb";
export const BLE_CHARACTERISTIC_UUID = "0000beef-0000-1000-8000-00805f9b34fb";
export const MAX_GATT_PAYLOAD_BYTES = 4096;
