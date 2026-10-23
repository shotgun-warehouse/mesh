import { NativeModule, requireNativeModule } from "expo";

import type {
  BleBroadcastModuleEvents,
  BluetoothState,
  BroadcastResult,
  SendPacketResult,
} from "./BleBroadcast.types";

declare class BleBroadcastModule extends NativeModule<BleBroadcastModuleEvents> {
  /** User-visible device name ("Alice's iPhone", "Galaxy A22 5G"), or null when unavailable. */
  readonly deviceName: string | null;
  /**
   * This install's mesh device ID: `byteCount` random bytes as lowercase hex, generated on first
   * call and stored outside backups.
   */
  getMeshId(byteCount: number): string;
  /**
   * Current Bluetooth availability. On iOS the first call creates the Bluetooth managers, which
   * shows the system permission prompt if the user has not answered it yet.
   */
  getBluetoothStateAsync(): Promise<BluetoothState>;
  /** Starts the GATT server and advertises `meshId` so peers know this device before connecting. */
  startBroadcastAsync(meshId: string): Promise<BroadcastResult>;
  stopBroadcastAsync(): Promise<void>;
  updateBroadcastAsync(jsonMessage: string): Promise<BroadcastResult>;
  isBroadcastingAsync(): Promise<boolean>;
  startScanAsync(): Promise<void>;
  stopScanAsync(): Promise<void>;
  isScanningAsync(): Promise<boolean>;
  /**
   * Sends a wire packet to every reachable peer once, except the peer behind the link
   * `excludeDeviceId`, or only to the peer whose mesh ID is `targetDeviceId` when set (none when no
   * link carries it). A peer gets a write over this device's link to it, or a notification when
   * only its link to this device is up.
   */
  sendPacketAsync(
    jsonMessage: string,
    excludeDeviceId?: string | null,
    targetDeviceId?: string | null,
  ): Promise<SendPacketResult>;
  /** Peers reachable over a link in either direction (a peer linked both ways counts once). */
  getConnectedPeerCountAsync(): Promise<number>;
  /** Lines of the synced-items file `fileKey` (lowercase hex); empty when it does not exist. */
  readItemsAsync(fileKey: string): Promise<string[]>;
  /** Appends lines (no newlines inside) to the synced-items file `fileKey`. */
  appendItemsAsync(fileKey: string, lines: string[]): Promise<void>;
  /** Keys of the synced-items files that exist. */
  listItemFilesAsync(): Promise<string[]>;
  /** Atomically replaces the synced-items file `fileKey` with `lines`; deletes it when empty. */
  replaceItemsAsync(fileKey: string, lines: string[]): Promise<void>;
}

export default requireNativeModule<BleBroadcastModule>("BleBroadcast");
