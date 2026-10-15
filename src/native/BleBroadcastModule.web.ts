import { registerWebModule, NativeModule } from "expo";

import {
  BluetoothState,
  BroadcastResult,
  SendPacketResult,
} from "./BleBroadcast.types";

class BleBroadcastModule extends NativeModule<{}> {
  readonly deviceName: string | null = null;

  getMeshId(byteCount: number): string {
    let meshId = "";
    for (let index = 0; index < byteCount; index += 1) {
      meshId += Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0");
    }
    return meshId;
  }

  getBluetoothStateAsync(): Promise<BluetoothState> {
    return Promise.resolve("unsupported");
  }

  startBroadcastAsync(_meshId: string): Promise<BroadcastResult> {
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
