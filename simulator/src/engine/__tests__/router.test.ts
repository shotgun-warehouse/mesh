import { buildSyncPacket } from "@mesh/packets";
import { MeshRouter } from "@mesh/router";
import type { MeshTransport, MeshTransportEvents } from "@mesh/transport";
import { afterEach, describe, expect, it } from "vitest";

type PeerConnectionEvent = Parameters<
  MeshTransportEvents["onPeerConnected"]
>[0];
type PeerDisconnectionEvent = Parameters<
  MeshTransportEvents["onPeerDisconnected"]
>[0];
type LinkDirection = PeerConnectionEvent["direction"];

const ME = "aaaa0001";
const PEER = "bbbb0002";

/** A transport whose link events the test fires by hand. */
class FakeTransport implements MeshTransport {
  private readonly listeners = {
    onMessageReceived: new Set<MeshTransportEvents["onMessageReceived"]>(),
    onPeerConnected: new Set<MeshTransportEvents["onPeerConnected"]>(),
    onPeerDisconnected: new Set<MeshTransportEvents["onPeerDisconnected"]>(),
  };

  addListener<EventName extends keyof MeshTransportEvents>(
    eventName: EventName,
    listener: MeshTransportEvents[EventName],
  ): { remove: () => void } {
    const listeners = this.listeners[eventName] as Set<
      MeshTransportEvents[EventName]
    >;
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  }

  /** Every wire payload sent, in order. */
  readonly sentPayloads: string[] = [];
  /** While set, sends wait for it: a write in flight. */
  gate: Promise<void> | null = null;

  async sendPacketAsync(wirePayload: string) {
    await this.gate;
    this.sentPayloads.push(wirePayload);
    return { sentCount: 1, readyPeerCount: 1, skippedExcluded: 0 };
  }

  async getConnectedPeerCountAsync() {
    return 1;
  }

  connect(
    deviceId: string,
    direction: LinkDirection,
    meshId: string | null = PEER,
  ): void {
    const event: PeerConnectionEvent = {
      deviceId,
      meshId,
      deviceName: null,
      rssi: null,
      direction,
    };
    for (const listener of this.listeners.onPeerConnected) listener(event);
  }

  disconnect(
    deviceId: string,
    direction: LinkDirection,
    meshId: string | null = PEER,
  ): void {
    const event: PeerDisconnectionEvent = { deviceId, meshId, direction };
    for (const listener of this.listeners.onPeerDisconnected) listener(event);
  }
}

const routers: MeshRouter[] = [];

afterEach(async () => {
  for (const router of routers.splice(0)) await router.stop();
});

async function startRouter() {
  const transport = new FakeTransport();
  const neighbourEvents: string[] = [];
  const router = new MeshRouter(
    ME,
    "Me",
    {
      onIdentity: () => {},
      onNeighbourUp: (deviceId) => neighbourEvents.push(`up:${deviceId}`),
      onNeighbourDown: (deviceId) => neighbourEvents.push(`down:${deviceId}`),
    },
    { transport, logger: () => {} },
  );
  routers.push(router);
  await router.start();
  return { router, transport, neighbourEvents };
}

describe("MeshRouter links", () => {
  it("keeps a neighbour linked both ways until its last link drops", async () => {
    const { transport, neighbourEvents } = await startRouter();

    transport.connect("link-out", "outbound");
    transport.connect("link-in", "inbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`]);

    transport.disconnect("link-out", "outbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`]);

    transport.disconnect("link-in", "inbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`, `down:${PEER}`]);
  });

  it("tells an outbound and an inbound link with the same BLE ID apart", async () => {
    const { transport, neighbourEvents } = await startRouter();

    transport.connect("AA:BB", "outbound");
    transport.connect("AA:BB", "inbound");
    transport.disconnect("AA:BB", "inbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`]);
  });

  it("brings a neighbour up once its link's device ID arrives", async () => {
    const { transport, neighbourEvents } = await startRouter();

    // An inbound link reported before the peer's hello, then again with it.
    transport.connect("link-in", "inbound", null);
    expect(neighbourEvents).toEqual([]);

    transport.connect("link-in", "inbound");
    transport.connect("link-in", "inbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`]);
  });

  it("ignores the disconnect of a link it never saw up", async () => {
    const { transport, neighbourEvents } = await startRouter();

    transport.connect("link-out", "outbound");
    transport.disconnect("stale-link", "outbound");
    expect(neighbourEvents).toEqual([`up:${PEER}`]);
  });
});

function itemPushPacket(seq: number) {
  return buildSyncPacket(
    ME,
    "syncItems",
    1,
    {
      parts: [
        {
          author: ME,
          seq,
          createdAt: seq,
          partIndex: 0,
          partCount: 1,
          bytes: new TextEncoder().encode(`item ${seq}`),
        },
      ],
    },
    7,
    null,
  );
}

describe("MeshRouter send queue", () => {
  it("keeps and sends promptly every part of this device's items", async () => {
    const { router, transport } = await startRouter();
    let openGate!: () => void;
    transport.gate = new Promise((resolve) => {
      openGate = resolve;
    });

    // A big photo: far more parts than the relay cap (100), all published at once.
    const packets = Array.from({ length: 300 }, (_, seq) =>
      itemPushPacket(seq),
    );
    const startedAt = Date.now();
    const sends = packets.map((packet) => router.sendSyncPacket(packet, null));
    openGate();
    await Promise.all(sends);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The identity beacon from start, then every part, none dropped.
    expect(transport.sentPayloads.length).toBe(1 + packets.length);
    // Relay pacing (100 ms each) would take 30 s.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
