export type MeshStatus =
  | "idle"
  | "starting"
  | "active"
  | "permissions_denied"
  | "error";

export type MeshPeer = {
  id: string;
  clientId: string | null;
  bleDeviceId: string;
  displayName: string;
  deviceName: string | null;
  rssi: number;
  lastSeen: number;
  isIdentified: boolean;
};

export type MeshInboundMessage = {
  json: string;
  senderId: string;
  displayName?: string;
  timestamp: number;
  bleDeviceId: string;
  deviceName: string | null;
  rssi: number;
};

export type MeshStartOptions = {
  displayName: string;
  clientId?: string;
  debug?: boolean;
  onMessage: (message: MeshInboundMessage) => void;
};
