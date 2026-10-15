import { createContext } from "react";

import type { MeshItem } from "../sync/types";
import type { MeshPeer, MeshStatus } from "./types";

export type MeshContextValue = {
  /** Where the mesh is in its lifecycle. Items spread to peers while this is `"running"`. */
  status: MeshStatus;
  /** Why the last start attempts failed, when `status` is `"error"`; otherwise null. */
  error: string | null;
  /**
   * This device's ID: derived from `deviceKey` when the provider has one, otherwise generated
   * once per install. Peers see it as `peer.id`; it is the `author` of the items it publishes.
   */
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
  /** A peer by its device ID. */
  getPeer: (peerId: string) => MeshPeer | undefined;
  /**
   * Adds an item to the synced set of the current `syncScope`: it is saved on this device and
   * reaches every device on the mesh, including devices that join or come back later. Works in
   * any status (an item published offline spreads once peers are around). Rejects when `data` is
   * over `MAX_ITEM_DATA_BYTES`, or when `syncScope` is `null`.
   */
  publishItem: (data: string) => Promise<MeshItem>;
  /**
   * Adds items the app already got from elsewhere (its server) to `scope`'s set, so repair does
   * not fetch them over Bluetooth again. Each item's author is derived from `deviceKey` the same
   * way as the `deviceKey` prop, so pass the author device's key: a server copy of an item then
   * matches the mesh's. The items are saved, served to neighbours that miss them, and neither
   * flooded nor passed to `onItemsReceived`. Works in any status and with repair off.
   *
   * Rejects, storing nothing, when `scope` is not the current `syncScope` (or stops being it while
   * the set loads), or when an item is invalid (`seq` not an integer from 1, `data` over
   * `MAX_ITEM_DATA_BYTES`, blank `deviceKey`).
   */
  addItems: (
    scope: string,
    items: {
      deviceKey: string;
      seq: number;
      createdAt: number;
      data: string;
    }[],
  ) => Promise<void>;
};

export const MeshContext = createContext<MeshContextValue | null>(null);
