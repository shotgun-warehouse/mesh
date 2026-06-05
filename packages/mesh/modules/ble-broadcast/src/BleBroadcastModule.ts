import { NativeModule, requireNativeModule } from "expo";

import type {
  BleBroadcastModuleEvents,
  BroadcastResult,
  SendPacketResult,
} from "./BleBroadcast.types";

declare class BleBroadcastModule extends NativeModule<BleBroadcastModuleEvents> {
  startBroadcastAsync(jsonMessage: string): Promise<BroadcastResult>;
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
