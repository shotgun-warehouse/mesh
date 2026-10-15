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
    _targetDeviceId?: string | null,
  ): Promise<SendPacketResult> {
    return Promise.reject(new Error("BleBroadcast is not available on web"));
  }

  getConnectedPeerCountAsync(): Promise<number> {
    return Promise.resolve(0);
  }

  /** In memory only: the web build has no mesh, items live as long as the page. */
  private readonly itemFiles = new Map<string, string[]>();

  readItemsAsync(fileKey: string): Promise<string[]> {
    return Promise.resolve([...(this.itemFiles.get(fileKey) ?? [])]);
  }

  appendItemsAsync(fileKey: string, lines: string[]): Promise<void> {
    this.itemFiles.set(fileKey, [
      ...(this.itemFiles.get(fileKey) ?? []),
      ...lines,
    ]);
    return Promise.resolve();
  }

  listItemFilesAsync(): Promise<string[]> {
    return Promise.resolve([...this.itemFiles.keys()]);
  }

  replaceItemsAsync(fileKey: string, lines: string[]): Promise<void> {
    if (lines.length === 0) {
      this.itemFiles.delete(fileKey);
    } else {
      this.itemFiles.set(fileKey, [...lines]);
    }
    return Promise.resolve();
  }
}

export default registerWebModule(BleBroadcastModule, "BleBroadcastModule");
