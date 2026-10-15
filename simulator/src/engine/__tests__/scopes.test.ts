import type { MeshItem } from "@sync/types";
import { describe, expect, it } from "vitest";

import { Engine } from "../engine";
import { decodeScan } from "../replica";
import type { SimNode } from "../simNode";
import type { DeviceSpec } from "../types";
import { begin, lineDevices, makeRun } from "./helpers";

const QUIET = { writeLoss: 0, linkMtbfMs: null, jitterMs: 0 };

function tidsOf(items: MeshItem[]): string[] {
  return items.map((item) => decodeScan(item.data, item.author)!.tid);
}

function storeTids(node: SimNode): Set<string> {
  return new Set(tidsOf(node.itemSync.items.all()));
}

function tidsInScope(engine: Engine, scope: string): Set<string> {
  return new Set(
    [...engine.itemScopes]
      .filter(([, itemScope]) => itemScope === scope)
      .map(([tid]) => tid),
  );
}

/** Seqs asked for over every exchange this node logged. */
function requestedSeqs(node: SimNode): number {
  return node.explanations.reduce(
    (sum, exchange) =>
      sum +
      exchange.requested.reduce(
        (rangeSum, [, fromSeq, toSeq]) => rangeSum + toSeq - fromSeq + 1,
        0,
      ),
    0,
  );
}

describe("sync scopes", () => {
  it("never moves an item across scopes, before and after a scope switch", async () => {
    // Six phones within range of each other: d1–d3 on event x, d4–d6 on event y.
    const devices: DeviceSpec[] = lineDevices(6, 2).map((device, index) => ({
      ...device,
      syncScope: index < 3 ? "x" : "y",
    }));
    const run = makeRun(devices, { ...QUIET, scanRatePerMin: 6 });
    run.actions = [
      { at: 3 * 60_000, do: "setScope", device: "d4", scope: "x" },
      { at: 6 * 60_000, do: "setParams", params: { scanRatePerMin: 0 } },
    ];
    const engine = await Engine.create(run, { routerLogLevel: "warn" });

    await engine.advanceTo(3 * 60_000 - 1);
    expect(engine.crossScopeArrivals).toBe(0);
    for (const node of engine.nodes.values()) {
      const inScope = tidsInScope(engine, node.syncScope!);
      for (const tid of storeTids(node)) expect(inScope.has(tid)).toBe(true);
    }

    await engine.advanceTo(7 * 60_000);
    expect(engine.crossScopeArrivals).toBe(0);
    const d4 = engine.nodes.get("d4")!;
    expect(d4.itemSync.currentScope).toBe("x");
    // d4 caught up on x's whole history and holds nothing of y.
    for (const node of engine.nodes.values()) {
      expect(storeTids(node)).toEqual(tidsInScope(engine, node.syncScope!));
    }
    expect(tidsInScope(engine, "x").size).toBeGreaterThan(20);
  });

  it("with syncScope null, stores and receives nothing but still relays pushes", async () => {
    // d1 — d2 — d3: d1 and d3 only reach each other through d2.
    const devices: DeviceSpec[] = lineDevices(3, 10).map((device) => ({
      ...device,
      syncScope: device.id === "d2" ? null : "x",
    }));
    const run = makeRun(devices, QUIET);
    run.actions = [{ at: 10_000, do: "burst", device: "d1", count: 5 }];
    const engine = await Engine.create(run, { routerLogLevel: "warn" });
    await engine.advanceTo(40_000);

    const [d1, d2, d3] = ["d1", "d2", "d3"].map((id) => engine.nodes.get(id)!);
    expect(d2!.itemSync.items.size).toBe(0);
    expect(d2!.replica.size).toBe(0);
    expect(storeTids(d3!)).toEqual(storeTids(d1!));
    expect(d3!.itemSync.items.size).toBe(5);
  });

  it("a late joiner seeded from the server asks only for the seqs it lacks", async () => {
    const devices: DeviceSpec[] = [
      ...lineDevices(2, 2),
      {
        id: "late",
        label: "Late",
        position: { x: 11, y: 10 },
        platform: "ios",
        power: "bluetoothOff",
      },
    ];
    const run = makeRun(devices, QUIET);
    run.actions = [{ at: 5_000, do: "burst", device: "d1", count: 30 }];
    const engine = await Engine.create(run, { routerLogLevel: "warn" });
    await engine.advanceTo(30_000);

    const d1 = engine.nodes.get("d1")!;
    const late = engine.nodes.get("late")!;
    // A burst refuses re-entries, so it can publish a little under 30 items.
    const total = d1.itemSync.items.size;
    expect(total).toBeGreaterThan(20);
    expect(engine.nodes.get("d2")!.itemSync.items.size).toBe(total);

    // The server has every scan but these (they never reached it).
    const notOnServer = new Set([1, 5, 12, 13, total]);
    const fromServer = d1.itemSync.items
      .all()
      .filter((item) => !notOnServer.has(item.seq));
    const { result } = await begin(engine, () => late.seed(fromServer));
    await engine.advanceBy(10);
    await result;
    expect(late.itemSync.items.size).toBe(total - notOnServer.size);

    await engine.applyLive({ do: "powerOn", device: "late" });
    await engine.advanceBy(30_000);

    expect(late.itemSync.items.size).toBe(total);
    expect(requestedSeqs(late)).toBe(notOnServer.size);
    expect(late.duplicateReceptions).toBe(0);
  });

  it("compares right away when repair turns on, without waiting for beacons", async () => {
    // d3 is up when d1 publishes, so d1's router floods right away instead of queueing the
    // pushes for the next link (which would hand them to d2 without repair).
    const devices: DeviceSpec[] = lineDevices(3, 2).map((device) => ({
      ...device,
      power: device.id === "d2" ? "bluetoothOff" : "on",
    }));
    const run = makeRun(devices, QUIET, { repair: false });
    run.actions = [
      { at: 5_000, do: "burst", device: "d1", count: 10 },
      { at: 20_000, do: "powerOn", device: "d2" },
    ];
    const engine = await Engine.create(run, { routerLogLevel: "warn" });
    // Long enough for every Trickle timer to back off to its 16 s maximum.
    await engine.advanceTo(90_000);
    const d1 = engine.nodes.get("d1")!;
    const d2 = engine.nodes.get("d2")!;
    expect(d1.itemSync.items.size).toBeGreaterThan(5);
    expect(d2.itemSync.items.size).toBe(0);

    await engine.applyLive({ do: "setSync", sync: { repair: true } });
    await engine.advanceBy(1_000);
    expect(d2.itemSync.items.size).toBe(d1.itemSync.items.size);
  });
});
