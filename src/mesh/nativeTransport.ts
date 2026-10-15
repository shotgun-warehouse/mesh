import BleBroadcast, { type BleBroadcastModuleEvents } from "../native";
import type { MeshTransport } from "./transport";

/** `MeshTransport` backed by the native BLE module. */
export const nativeMeshTransport: MeshTransport = {
  addListener: (eventName, listener) =>
    BleBroadcast.addListener(
      eventName,
      listener as BleBroadcastModuleEvents[typeof eventName],
    ),
  sendPacketAsync: (wirePayload, excludeDeviceId, targetDeviceId) =>
    BleBroadcast.sendPacketAsync(wirePayload, excludeDeviceId, targetDeviceId),
  getConnectedPeerCountAsync: () => BleBroadcast.getConnectedPeerCountAsync(),
};
