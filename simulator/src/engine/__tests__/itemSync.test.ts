import { MAX_ITEM_DATA_BYTES } from "@mesh/constants";
import { deviceIdFromKey, isDeviceId } from "@mesh/ids";
import { buildSyncPacket, type MeshSessionPacket } from "@mesh/packets";
import { MeshItemSync } from "@sync/itemSync";
import {
  decodePersistedLines,
  encodeItemLine,
  encodeSeqFloorsLine,
  type MeshItemPersistence,
} from "@sync/persistence";
import { createMemoryPersistence } from "../memoryPersistence";
import type { MeshSyncLink } from "@sync/sync";
import { scopeHash, type MeshItem } from "@sync/types";
import { afterEach, describe, expect, it } from "vitest";

const ME = "aaaa0001";
const PEER = "bbbb0002";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function memoryPersistence(gate?: Deferred) {
  return createMemoryPersistence(gate?.promise);
}

const created: MeshItemSync[] = [];

function makeItemSync(persistence: MeshItemPersistence): MeshItemSync {
  const itemSync = new MeshItemSync({
    deviceId: ME,
    persistence,
    syncOptions: () => ({ maxItemsPerRequest: 500 }),
    onItems: () => {},
    log: () => {},
  });
  created.push(itemSync);
  return itemSync;
}

afterEach(() => {
  for (const itemSync of created.splice(0)) itemSync.detach();
});

function item(author: string, seq: number, data = `scan ${seq}`): MeshItem {
  return { author, seq, createdAt: seq, data };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("deviceIdFromKey", () => {
  it("derives a stable device ID from any key", () => {
    for (const key of ["01JABCDEFGHJK", "x", "é".repeat(40)]) {
      const deviceId = deviceIdFromKey(key);
      expect(isDeviceId(deviceId)).toBe(true);
      expect(deviceIdFromKey(key)).toBe(deviceId);
    }
    expect(deviceIdFromKey("a")).not.toBe(deviceIdFromKey("b"));
  });

  it("is the scope hash as 8 hex chars", () => {
    expect(deviceIdFromKey("01JABCDEFGHJK")).toBe(
      scopeHash("01JABCDEFGHJK").toString(16).padStart(8, "0"),
    );
  });
});

describe("MeshItemSync.addItems", () => {
  it("adds and persists only the new items, without delivering them", async () => {
    const { files, persistence } = memoryPersistence();
    const delivered: MeshItem[] = [];
    const itemSync = new MeshItemSync({
      deviceId: ME,
      persistence,
      syncOptions: () => undefined,
      onItems: (items) => delivered.push(...items),
      log: () => {},
    });
    await itemSync.setScope("x");
    await itemSync.addItems("x", [item(PEER, 1), item(PEER, 3)]);
    await itemSync.addItems("x", [item(PEER, 3), item(PEER, 4)]);
    expect(itemSync.items.size).toBe(3);
    expect(files.get("x")!.map((stored) => stored.seq)).toEqual([1, 3, 4]);
    expect(delivered).toEqual([]);
    expect(itemSync.items.duplicates).toBe(0);
  });

  it("continues this device's own seqs after seeded ones", async () => {
    const itemSync = makeItemSync(memoryPersistence().persistence);
    await itemSync.setScope("x");
    await itemSync.addItems("x", [item(ME, 7)]);
    expect((await itemSync.publish("next", 0)).seq).toBe(8);
  });

  it("rejects items for another scope, or with no scope", async () => {
    const itemSync = makeItemSync(memoryPersistence().persistence);
    await expect(itemSync.addItems("x", [item(PEER, 1)])).rejects.toThrow(
      /scope "x".*current syncScope is none/,
    );
    await itemSync.setScope("y");
    await expect(itemSync.addItems("x", [item(PEER, 1)])).rejects.toThrow(
      /scope "x".*current syncScope is "y"/,
    );
    expect(itemSync.items.size).toBe(0);
  });

  it("rejects, storing nothing, when the scope changes while the set loads", async () => {
    const gate = deferred();
    const { files, persistence } = memoryPersistence(gate);
    const itemSync = makeItemSync(persistence);
    void itemSync.setScope("x");
    const adding = itemSync.addItems("x", [item(PEER, 1)]);
    void itemSync.setScope("y");
    gate.resolve();
    await expect(adding).rejects.toThrow(/changed from "x" to "y"/);
    await itemSync.ready();
    expect(itemSync.items.size).toBe(0);
    expect(files.size).toBe(0);
  });

  it("rejects the whole call on one invalid item", async () => {
    const { files, persistence } = memoryPersistence();
    const itemSync = makeItemSync(persistence);
    await itemSync.setScope("x");
    for (const invalid of [
      item(PEER, 0),
      item(PEER, 1.5),
      item(PEER, 2, "x".repeat(MAX_ITEM_DATA_BYTES + 1)),
    ]) {
      await expect(
        itemSync.addItems("x", [item(PEER, 1), invalid]),
      ).rejects.toThrow();
    }
    expect(itemSync.items.size).toBe(0);
    expect(files.size).toBe(0);
  });
});

describe("MeshItemSync scopes", () => {
  it("with no scope, publishItem rejects and packets are ignored", async () => {
    const sent: MeshSessionPacket[] = [];
    const link: MeshSyncLink = {
      localDeviceId: ME,
      sendSyncPacket: async (packet) => {
        sent.push(packet);
      },
    };
    const itemSync = makeItemSync(memoryPersistence().persistence);
    await itemSync.setScope(null);
    itemSync.attach(link);
    itemSync.neighbourUp(PEER);
    itemSync.handlePacket(
      buildSyncPacket(
        PEER,
        "syncVector",
        scopeHash("x"),
        { vector: [[PEER, 3]] },
        0,
        ME,
      ),
      PEER,
    );
    itemSync.compareNow();
    await flush();
    await expect(itemSync.publish("scan", 0)).rejects.toThrow(
      "No sync scope: publishItem needs a syncScope",
    );
    expect(sent).toEqual([]);

    // A scope set later starts sync on the kept link and greets the neighbour.
    await itemSync.setScope("x");
    await flush();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((packet) => packet.scope === scopeHash("x"))).toBe(true);
  });

  it("sends nothing of the old scope after a switch, even mid-answer", async () => {
    const sent: MeshSessionPacket[] = [];
    const link: MeshSyncLink = {
      localDeviceId: ME,
      sendSyncPacket: async (packet) => {
        sent.push(packet);
        await flush();
      },
    };
    const itemSync = makeItemSync(memoryPersistence().persistence);
    await itemSync.setScope("x");
    await itemSync.addItems(
      "x",
      Array.from({ length: 50 }, (_, index) =>
        item(PEER, index + 1, "y".repeat(400)),
      ),
    );
    itemSync.attach(link);
    await flush();
    itemSync.neighbourUp(PEER);
    itemSync.handlePacket(
      buildSyncPacket(
        PEER,
        "syncRequest",
        scopeHash("x"),
        { ranges: [[PEER, 1, 50]] },
        0,
        ME,
      ),
      PEER,
    );
    await flush();
    const answered = sent.filter(
      (packet) => packet.packetType === "syncItems",
    ).length;
    expect(answered).toBeGreaterThan(0);

    const switchedAt = sent.length;
    await itemSync.setScope("y");
    itemSync.compareNow();
    for (let turn = 0; turn < 60; turn += 1) await flush();

    const afterSwitch = sent.slice(switchedAt);
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every((packet) => packet.scope === scopeHash("y"))).toBe(
      true,
    );
    expect(
      sent.filter((packet) => packet.packetType === "syncItems").length,
    ).toBeLessThan(50);
  });
});

describe("MeshItemSync.clear", () => {
  it("deletes every scope's items from disk and memory", async () => {
    const { files, persistence } = memoryPersistence();
    const itemSync = makeItemSync(persistence);
    await itemSync.setScope("x");
    await itemSync.publish("one", 0);
    await itemSync.addItems("x", [item(PEER, 1)]);
    await itemSync.setScope("y");
    await itemSync.publish("two", 0);

    await itemSync.clear();

    expect(itemSync.items.size).toBe(0);
    expect(files.size).toBe(0);
    await itemSync.setScope("x");
    expect(itemSync.items.size).toBe(0);
  });

  it("keeps numbering this device's items after the deleted ones", async () => {
    const { persistence } = memoryPersistence();
    const itemSync = makeItemSync(persistence);
    await itemSync.setScope("x");
    await itemSync.publish("one", 0);
    await itemSync.publish("two", 0);
    await itemSync.setScope("y");
    await itemSync.publish("other scope", 0);

    await itemSync.clear();
    expect((await itemSync.publish("after clear", 0)).seq).toBe(2);

    // A new launch reads the floors from disk.
    const relaunched = makeItemSync(persistence);
    await relaunched.setScope("x");
    expect((await relaunched.publish("next launch", 0)).seq).toBe(3);
  });

  it("keeps the items published while it runs", async () => {
    const { files, persistence } = memoryPersistence();
    const itemSync = makeItemSync(persistence);
    await itemSync.setScope("x");
    await itemSync.publish("before", 0);

    const clearing = itemSync.clear();
    const during = itemSync.publish("during", 0);
    await clearing;
    expect((await during).seq).toBe(2);

    expect(files.get("x")!.map((stored) => stored.data)).toEqual(["during"]);
    expect(itemSync.items.size).toBe(1);
  });

  it("waits for the set to load before emptying it", async () => {
    const gate = deferred();
    const { persistence } = memoryPersistence(gate);
    const itemSync = makeItemSync(persistence);
    void itemSync.setScope("x");

    const clearing = itemSync.clear();
    gate.resolve();
    await clearing;
    expect(itemSync.items.size).toBe(0);
  });
});

describe("persisted lines", () => {
  it("reads items and seq floors lines back", () => {
    const lines = [
      encodeItemLine(item(PEER, 4)),
      encodeSeqFloorsLine({ [ME]: 9, [PEER]: 2 }),
      encodeSeqFloorsLine({ [ME]: 5 }),
      '[{"torn',
    ];
    expect(decodePersistedLines(lines)).toEqual({
      items: [item(PEER, 4)],
      seqFloors: { [ME]: 9, [PEER]: 2 },
    });
  });
});
