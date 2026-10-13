import { getPeerLabel } from "../mesh/peerLabel";

import type { MeshPeer } from "./types";

/** A peer as the provider stores it: the announced name is kept apart from the fallbacks. */
export type MeshPeerRecord = {
  id: string;
  /** Name from the peer's identity packet. Only identity packets carry a name. */
  announcedName: string | null;
  deviceName: string | null;
  rssi: number | null;
  lastSeen: number;
};

export type MeshPeerUpdate = {
  id: string;
  announcedName?: string;
  deviceName?: string | null;
  rssi?: number;
  lastSeen: number;
};

export function upsertPeer(
  previousPeers: MeshPeerRecord[],
  update: MeshPeerUpdate,
): MeshPeerRecord[] {
  const existingIndex = previousPeers.findIndex(
    (peer) => peer.id === update.id,
  );
  const existingPeer =
    existingIndex === -1 ? undefined : previousPeers[existingIndex];

  const nextPeer: MeshPeerRecord = {
    id: update.id,
    announcedName:
      update.announcedName || (existingPeer?.announcedName ?? null),
    deviceName: update.deviceName ?? existingPeer?.deviceName ?? null,
    rssi: update.rssi ?? existingPeer?.rssi ?? null,
    lastSeen: Math.max(update.lastSeen, existingPeer?.lastSeen ?? 0),
  };

  const nextPeers =
    existingIndex === -1
      ? [nextPeer, ...previousPeers]
      : previousPeers.map((peer, index) =>
          index === existingIndex ? nextPeer : peer,
        );

  return nextPeers.sort(
    (leftPeer, rightPeer) => rightPeer.lastSeen - leftPeer.lastSeen,
  );
}

export function removePeer(
  previousPeers: MeshPeerRecord[],
  peerId: string,
): MeshPeerRecord[] {
  return previousPeers.filter((peer) => peer.id !== peerId);
}

export function toMeshPeer(peer: MeshPeerRecord): MeshPeer {
  return {
    id: peer.id,
    displayName:
      peer.announcedName ??
      getPeerLabel({ id: peer.id, deviceName: peer.deviceName }),
    deviceName: peer.deviceName,
    rssi: peer.rssi,
    lastSeen: peer.lastSeen,
  };
}
