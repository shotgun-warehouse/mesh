import { encodeWirePacket, buildIdentityPacket } from "@mesh/packets";
import { describe, expect, it } from "vitest";

import { Engine } from "../engine";
import { begin, lineDevices, makeRun } from "./helpers";

/** d1 — d2 — d3, 10 m apart; range 15 m, so d1 and d3 only reach each other through d2. */
async function threeInALine(params = {}) {
  const engine = await Engine.create(
    makeRun(lineDevices(3, 10), {
      jitterMs: 0,
      writeLoss: 0,
      linkMtbfMs: null,
      ...params,
    }),
  );
  // Past the first identity-beacon round, so write queues are idle.
  await engine.advanceTo(6_500);
  return engine;
}

function identityPayload(engine: Engine, deviceId: string): string {
  return encodeWirePacket(
    buildIdentityPacket(engine.meshIdOf(deviceId), "probe"),
  );
}

describe("medium", () => {
  it("links neighbours within range only", async () => {
    const engine = await threeInALine();
    const keys = [...engine.medium.links.values()]
      .filter((link) => link.state === "up")
      .map((link) => link.key)
      .sort();
    expect(keys).toEqual(["d1|d2", "d2|d3"]);
  });

  it("respects the per-device link cap", async () => {
    const devices = lineDevices(6, 1).map((device) => ({
      ...device,
      maxLinks: 2,
    }));
    const engine = await Engine.create(makeRun(devices, { linkMtbfMs: null }));
    await engine.advanceTo(10_000);
    for (const id of engine.nodes.keys()) {
      expect(engine.medium.linkCountOf(id)).toBeLessThanOrEqual(2);
    }
  });

  it("does not link through a wall", async () => {
    const run = makeRun(lineDevices(2, 10), { linkMtbfMs: null });
    run.config.walls = [{ id: "w", a: { x: 15, y: 0 }, b: { x: 15, y: 20 } }];
    const engine = await Engine.create(run);
    await engine.advanceTo(10_000);
    expect(engine.medium.links.size).toBe(0);
  });
});

describe("SimTransport contract", () => {
  it("writes to every ready link except the excluded one", async () => {
    const engine = await threeInALine();
    const transport = engine.nodes.get("d2")!.transport;
    const { result } = await begin(engine, () =>
      transport.sendPacketAsync(
        identityPayload(engine, "d2"),
        engine.meshIdOf("d1"),
        null,
      ),
    );
    await engine.advanceBy(1_000);
    expect(await result).toEqual({
      sentCount: 1,
      readyPeerCount: 2,
      skippedExcluded: 1,
    });
  });

  it("does not count failed writes", async () => {
    const engine = await threeInALine({ writeLoss: 1 });
    const transport = engine.nodes.get("d2")!.transport;
    const { result } = await begin(engine, () =>
      transport.sendPacketAsync(identityPayload(engine, "d2"), null, null),
    );
    await engine.advanceBy(1_000);
    expect(await result).toEqual({
      sentCount: 0,
      readyPeerCount: 2,
      skippedExcluded: 0,
    });
  });

  it("rejects packets over 512 bytes", async () => {
    const engine = await threeInALine();
    const transport = engine.nodes.get("d2")!.transport;
    const oversized = btoa("S".repeat(600));
    await expect(
      transport.sendPacketAsync(oversized, null, null),
    ).rejects.toThrow(/512/);
    expect(engine.summary().oversizePackets).toBe(1);
  });

  it("keeps one write in flight per device", async () => {
    const engine = await threeInALine({ writeLatencyMs: 20 });
    const transport = engine.nodes.get("d2")!.transport;
    const finished: number[] = [];
    const startedAt = engine.now();
    await begin(engine, async () => {
      await Promise.all([
        transport
          .sendPacketAsync(identityPayload(engine, "d2"), null, null)
          .then(() => finished.push(engine.now())),
        transport
          .sendPacketAsync(identityPayload(engine, "d2"), null, null)
          .then(() => finished.push(engine.now())),
      ]);
    });
    await engine.advanceBy(1_000);
    // 2 packets × 2 links × (20 ms + 2 ms for 10 m), strictly one after another.
    expect(finished).toHaveLength(2);
    expect(finished[0]! - startedAt).toBeGreaterThanOrEqual(44);
    expect(finished[1]! - startedAt).toBeGreaterThanOrEqual(88);
  });

  it("fails a write when its link drops mid-write and reports the disconnect", async () => {
    const engine = await threeInALine({ writeLatencyMs: 50 });
    const transport = engine.nodes.get("d1")!.transport;
    expect(engine.nodes.get("d2")!.peerCount).toBe(2);
    const { result } = await begin(engine, () =>
      transport.sendPacketAsync(identityPayload(engine, "d1"), null, null),
    );
    await engine.advanceBy(10);
    await engine.applyLive({ do: "blockLink", a: "d1", b: "d2" });
    await engine.advanceBy(1_000);
    expect(await result).toEqual({
      sentCount: 0,
      readyPeerCount: 1,
      skippedExcluded: 0,
    });
    expect(engine.nodes.get("d2")!.peerCount).toBe(1);
  });

  it("writes only to the target when one is given", async () => {
    const engine = await threeInALine();
    const transport = engine.nodes.get("d2")!.transport;
    const { result } = await begin(engine, () =>
      transport.sendPacketAsync(
        identityPayload(engine, "d2"),
        null,
        engine.meshIdOf("d3"),
      ),
    );
    await engine.advanceBy(1_000);
    expect(await result).toEqual({
      sentCount: 1,
      readyPeerCount: 2,
      skippedExcluded: 0,
    });
  });

  it("delivers with the sender's mesh ID as the link ID", async () => {
    const engine = await threeInALine();
    const received: { deviceId: string; viaDeviceId: string }[] = [];
    engine.nodes
      .get("d3")!
      .transport.addListener("onMessageReceived", (message) => {
        received.push({
          deviceId: message.deviceId,
          viaDeviceId: message.viaDeviceId,
        });
      });
    await begin(engine, () =>
      engine.nodes
        .get("d2")!
        .transport.sendPacketAsync(identityPayload(engine, "d2"), null, null),
    );
    await engine.advanceBy(100);
    const meshId = engine.meshIdOf("d2");
    expect(received).toContainEqual({ deviceId: meshId, viaDeviceId: meshId });
  });
});
