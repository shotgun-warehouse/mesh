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
   * Sends one wire packet to every reachable peer once, except the peer behind the link
   * `excludeDeviceId`, or, when `targetDeviceId` (a mesh device ID) is set, only to that device.
   */
  sendPacketAsync(
    wirePayload: string,
    excludeDeviceId: string | null,
    targetDeviceId: string | null,
  ): Promise<SendPacketResult>;
  getConnectedPeerCountAsync(): Promise<number>;
}
