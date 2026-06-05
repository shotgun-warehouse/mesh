import type { MeshPeer } from "./types";

export function findPeerById(
  peerList: MeshPeer[],
  peerId: string,
): MeshPeer | undefined {
  return peerList.find(
    (peer) => peer.id === peerId || peer.bleDeviceId === peerId,
  );
}

export function upsertPeer(
  previousPeers: MeshPeer[],
  nextPeer: MeshPeer,
): MeshPeer[] {
  const existingIndex = previousPeers.findIndex(
    (peer) =>
      peer.bleDeviceId === nextPeer.bleDeviceId ||
      (nextPeer.isIdentified &&
        nextPeer.clientId &&
        peer.clientId === nextPeer.clientId),
  );

  if (existingIndex === -1) {
    return [nextPeer, ...previousPeers];
  }

  const existingPeer = previousPeers[existingIndex]!;
  const updatedPeers = [...previousPeers];
  updatedPeers[existingIndex] = {
    ...existingPeer,
    ...nextPeer,
    clientId: nextPeer.isIdentified ? nextPeer.clientId : existingPeer.clientId,
    isIdentified: nextPeer.isIdentified || existingPeer.isIdentified,
    displayName: nextPeer.displayName || existingPeer.displayName,
  };
  return updatedPeers;
}

export function sortPeersByActivity(peerList: MeshPeer[]): MeshPeer[] {
  return [...peerList].sort(
    (leftPeer, rightPeer) => rightPeer.lastSeen - leftPeer.lastSeen,
  );
}

export function toMeshPeer(input: {
  clientId: string | null;
  bleDeviceId: string;
  isIdentified: boolean;
  deviceName: string | null;
  displayName?: string;
  rssi: number;
  lastSeen: number;
}): MeshPeer {
  const displayName =
    input.displayName ??
    input.deviceName ??
    (input.isIdentified && input.clientId
      ? input.clientId.slice(0, 8)
      : "Connecting…");

  return {
    id:
      input.isIdentified && input.clientId ? input.clientId : input.bleDeviceId,
    clientId: input.clientId,
    bleDeviceId: input.bleDeviceId,
    displayName,
    deviceName: input.deviceName,
    rssi: input.rssi,
    lastSeen: input.lastSeen,
    isIdentified: input.isIdentified,
  };
}
