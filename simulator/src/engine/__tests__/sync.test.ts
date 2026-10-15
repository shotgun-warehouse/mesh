import {
  decodeWirePacket,
  encodeWirePacket,
  buildSyncPacket,
} from "@mesh/packets";
import { MAX_ITEM_DATA_BYTES } from "@mesh/constants";
import { decodeItemLine, encodeItemLine } from "@sync/persistence";
import { MeshItemStore } from "@sync/store";
import { splitItem } from "@sync/sync";
import type { MeshItem } from "@sync/types";
import { describe, expect, it } from "vitest";

import { mulberry32 } from "../random";
import { Replica } from "../replica";

const AUTHORS = ["aaaa0001", "bbbb0002", "cccc0003"];

function makeItems(count: number): MeshItem[] {
  const rng = mulberry32(3);
  const seqs = new Map<string, number>();
  return Array.from({ length: count }, (_, index) => {
    const author = AUTHORS[Math.floor(rng() * AUTHORS.length)]!;
    const seq = (seqs.get(author) ?? 0) + 1;
    seqs.set(author, seq);
    return {
      author,
      seq,
      createdAt: 1_760_000_000_000 + index,
      data: `scan ${index}`,
    };
  });
}

function shuffled<T>(values: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

describe("MeshItemStore (G-Set)", () => {
  it("ends in the same state whatever the arrival order", () => {
    const items = makeItems(200);
    const reference = new MeshItemStore();
    reference.add(items);
    for (const seed of [1, 2, 3]) {
      const other = new MeshItemStore();
      for (const item of shuffled(items, seed)) other.add([item]);
      expect(other.digest()).toEqual(reference.digest());
      expect(other.versionVector()).toEqual(reference.versionVector());
    }
  });

  it("ignores re-received items and counts them as duplicates", () => {
    const store = new MeshItemStore();
    const items = makeItems(20);
    store.add(items);
    const digest = store.digest();
    expect(store.add(items.slice(0, 5))).toEqual([]);
    expect(store.digest()).toEqual(digest);
    expect(store.duplicates).toBe(5);
  });

  it("tracks the contiguous prefix per author in the version vector", () => {
    const store = new MeshItemStore();
    const item = (seq: number): MeshItem => ({
      author: "aaaa0001",
      seq,
      createdAt: seq,
      data: "",
    });
    store.add([item(1), item(2), item(4)]);
    expect(store.versionVector()).toEqual({ aaaa0001: 2 });
    store.add([item(3)]);
    expect(store.versionVector()).toEqual({ aaaa0001: 4 });
  });

  it("continues local seqs after loading, and never reuses seqs peers already saw", () => {
    const store = new MeshItemStore();
    store.add([{ author: "aaaa0001", seq: 3, createdAt: 0, data: "" }]);
    expect(store.createLocal("aaaa0001", "next", 1).seq).toBe(4);
    store.reserveSeq("aaaa0001", 10);
    expect(store.createLocal("aaaa0001", "after wipe", 2).seq).toBe(11);
  });

  it("rejects data over MAX_ITEM_DATA_BYTES", () => {
    const store = new MeshItemStore();
    expect(() =>
      store.createLocal("aaaa0001", "x".repeat(MAX_ITEM_DATA_BYTES + 1), 0),
    ).toThrow(/limit/);
  });
});

describe("sync wire format", () => {
  it("round-trips item parts, vectors, requests and digests with their scope", () => {
    const [item] = makeItems(1);
    const big = { ...item!, data: "é".repeat(900) };
    const packets = [
      buildSyncPacket(
        "aaaa0001",
        "syncItems",
        0xfedcba98,
        { parts: splitItem(big).slice(0, 1) },
        7,
        null,
      ),
      buildSyncPacket(
        "aaaa0001",
        "syncVector",
        0xfedcba98,
        { vector: [["bbbb0002", 9]] },
        0,
        "bbbb0002",
      ),
      buildSyncPacket(
        "aaaa0001",
        "syncRequest",
        0xfedcba98,
        { ranges: [["cccc0003", 2, 5]] },
        0,
        "cccc0003",
      ),
      buildSyncPacket(
        "aaaa0001",
        "syncDigest",
        0xfedcba98,
        { digest: { xor: 0x89abcdef, count: 4 } },
        0,
        null,
      ),
    ];
    for (const packet of packets) {
      const decoded = decodeWirePacket(encodeWirePacket(packet))!;
      // Hashes above 2^31 must come back unsigned.
      expect(decoded.scope).toBe(0xfedcba98);
      expect(decoded.parts ?? undefined).toEqual(packet.parts);
      expect(decoded.vector ?? undefined).toEqual(packet.vector);
      expect(decoded.ranges ?? undefined).toEqual(packet.ranges);
      expect(decoded.digest ?? undefined).toEqual(packet.digest);
    }
  });

  it("splits large items into parts that each fit one packet", () => {
    const item: MeshItem = {
      author: "aaaa0001",
      seq: 1,
      createdAt: 5,
      data: "x".repeat(MAX_ITEM_DATA_BYTES),
    };
    const parts = splitItem(item);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) {
      expect(() =>
        encodeWirePacket(
          buildSyncPacket(
            "aaaa0001",
            "syncItems",
            1,
            { parts: [part] },
            0,
            "bbbb0002",
          ),
        ),
      ).not.toThrow();
    }
  });

  it("round-trips items through the persistence line format", () => {
    for (const item of makeItems(5)) {
      expect(
        decodeItemLine(
          encodeItemLine({ ...item, data: 'with "quotes"\nand lines' }),
        ),
      ).toEqual({
        ...item,
        data: 'with "quotes"\nand lines',
      });
    }
    expect(decodeItemLine('["torn')).toBeNull();
  });
});

describe("simulated app view", () => {
  it("folds the same tickets whatever the arrival order", () => {
    const rng = mulberry32(5);
    const views = AUTHORS.map(() => new Replica());
    const all = [];
    for (let step = 0; step < 200; step += 1) {
      const authorIndex = Math.floor(rng() * AUTHORS.length);
      const view = views[authorIndex]!;
      const ticketId = 1 + Math.floor(rng() * 10);
      const action = view.ticketState(ticketId).inside ? "checkout" : "scan";
      const item = view.createLocal(
        `t-${step}`,
        AUTHORS[authorIndex]!,
        ticketId,
        action,
        step,
      );
      all.push(item);
      views.forEach((other, index) => {
        if (index !== authorIndex && rng() < 0.5)
          other.add(item, { at: step, via: null, channel: "flood" });
      });
    }
    const reference = new Replica();
    for (const item of all)
      reference.add(item, { at: 0, via: null, channel: "flood" });
    const other = new Replica();
    for (const item of shuffled(all, 9))
      other.add(item, { at: 0, via: null, channel: "repair" });
    expect(other.ticketView()).toEqual(reference.ticketView());
  });
});
