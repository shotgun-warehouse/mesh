const MESH_AD_NAME_PREFIX = "SM:";

export type PeerLabelInput = {
  clientId?: string | null;
  displayName?: string;
  deviceName?: string | null;
  isIdentified?: boolean;
};

export function formatShortId(fullId: string): string {
  return fullId.slice(0, 8);
}

function isMeshAdvertisementName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.startsWith(MESH_AD_NAME_PREFIX);
}

export function getPeerLabel(peer: PeerLabelInput): string {
  if (peer.displayName) {
    return peer.displayName;
  }

  if (peer.deviceName && !isMeshAdvertisementName(peer.deviceName)) {
    return peer.deviceName;
  }

  if (peer.clientId) {
    return formatShortId(peer.clientId);
  }

  return "Connecting…";
}
