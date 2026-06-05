import { registerWebModule, NativeModule } from "expo";

import { BroadcastResult, SendPacketResult } from "./BleBroadcast.types";

class BleBroadcastModule extends NativeModule<{}> {
  startBroadcastAsync(_jsonMessage: string): Promise<BroadcastResult> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  stopBroadcastAsync(): Promise<void> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  updateBroadcastAsync(_jsonMessage: string): Promise<BroadcastResult> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  isBroadcastingAsync(): Promise<boolean> {
    return Promise.resolve(false);
  }

  startScanAsync(): Promise<void> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  stopScanAsync(): Promise<void> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  isScanningAsync(): Promise<boolean> {
    return Promise.resolve(false);
  }

  sendPacketAsync(
    _jsonMessage: string,
    _excludeDeviceId?: string | null,
  ): Promise<SendPacketResult> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  getConnectedPeerCountAsync(): Promise<number> {
    return Promise.resolve(0);
  }
}

export default registerWebModule(BleBroadcastModule, "BleBroadcastModule");
