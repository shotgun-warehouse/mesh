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
  sendPacketAsync(
    jsonMessage: string,
    excludeDeviceId?: string | null,
  ): Promise<SendPacketResult>;
  getConnectedPeerCountAsync(): Promise<number>;
}

export default requireNativeModule<BleBroadcastModule>("BleBroadcast");
