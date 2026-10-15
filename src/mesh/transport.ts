import type {
  BleBroadcastModuleEvents,
  SendPacketResult,
} from "../native/BleBroadcast.types";

export type MeshTransportEvents = Pick<
  BleBroadcastModuleEvents,
  "onMessageReceived" | "onPeerConnected" | "onPeerDisconnected"
>;

/**
 * What `MeshRouter` needs from the radio. The app uses the native BLE module
 * (`nativeMeshTransport`); the simulator plugs in a simulated medium.
 */
export interface MeshTransport {
  addListener<EventName extends keyof MeshTransportEvents>(
    eventName: EventName,
    listener: MeshTransportEvents[EventName],
  ): { remove: () => void };
  /**
   * Writes one wire packet to every ready link except `excludeDeviceId` (a link ID), or, when
   * `targetDeviceId` (a mesh device ID) is set, only to the link of that device.
   */
  sendPacketAsync(
    wirePayload: string,
    excludeDeviceId: string | null,
    targetDeviceId: string | null,
  ): Promise<SendPacketResult>;
  getConnectedPeerCountAsync(): Promise<number>;
}
