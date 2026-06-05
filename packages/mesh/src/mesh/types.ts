export type MeshPresence = {
  type: "mesh.presence";
  clientId: string;
  displayName?: string;
  toClientId?: string;
  messageId?: string;
  text?: string;
  ts: number;
};

export type Peer = {
  clientId: string;
  bleDeviceId: string;
  /** True once the peer's mesh clientId is known from an identity packet. */
  isIdentified: boolean;
  deviceName: string | null;
  displayName?: string;
  rssi: number;
  lastSeen: number;
};
