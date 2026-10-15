import { describe, expect, it } from "vitest";

import { Engine } from "../engine";
import { buildPresetRun } from "../presets";
import { decodeRun, encodeRun } from "../run";
import type { RunFile } from "../types";

function hostileTwoHalls(seed: number): RunFile {
  const { config, actions } = buildPresetRun("two-halls");
  Object.assign(config.params, {
    writeLoss: 0.1,
    linkMtbfMs: 20_000,
    appKillsPerHour: 20,
    bluetoothTogglesPerHour: 20,
    scanRatePerMin: 12,
  });
  return { seed, config, actions };
}

async function runFor(run: RunFile, until: number): Promise<Engine> {
  const engine = await Engine.create(run, { routerLogLevel: "debug" });
  await engine.advanceTo(until);
  return engine;
}

describe("determinism", () => {
  it("gives the same event log for the same seed", async () => {
    const first = await runFor(hostileTwoHalls(42), 120_000);
    const second = await runFor(hostileTwoHalls(42), 120_000);
    expect(first.metrics.items.size).toBeGreaterThan(100);
    expect(second.eventLogHash()).toBe(first.eventLogHash());
    expect(second.summary()).toEqual(first.summary());
  });

  it("gives a different run for another seed", async () => {
    const first = await runFor(hostileTwoHalls(42), 60_000);
    const second = await runFor(hostileTwoHalls(43), 60_000);
    expect(second.eventLogHash()).not.toBe(first.eventLogHash());
  });

  it("does not depend on how time is chunked", async () => {
    const whole = await runFor(hostileTwoHalls(9), 60_000);
    const chunked = await Engine.create(hostileTwoHalls(9), {
      routerLogLevel: "debug",
    });
    for (let t = 0; t < 60_000; t += 333) await chunked.advanceTo(t);
    await chunked.advanceTo(60_000);
    expect(chunked.eventLogHash()).toBe(whole.eventLogHash());
  });

  it("replays live actions exactly, including mid-millisecond ones and single steps", async () => {
    const live = await Engine.create(hostileTwoHalls(5), {
      routerLogLevel: "debug",
    });
    await live.advanceTo(20_000.4);
    await live.applyLive({ do: "blockLink", a: "hall-a-3", b: "corridor" });
    for (let index = 0; index < 37; index += 1) await live.step();
    await live.applyLive({ do: "burst", device: "hall-b-2", count: 5 });
    await live.advanceTo(31_000);
    await live.applyLive({
      do: "moveDevice",
      device: "corridor",
      position: { x: 60, y: 40 },
    });
    await live.applyLive({ do: "killApp", device: "hall-a-1" });
    await live.advanceTo(45_000);
    await live.applyLive({ do: "setParams", params: { writeLoss: 0.3 } });
    await live.advanceTo(70_000);

    const exported = live.exportRun();
    const roundTripped = await decodeRun(await encodeRun(exported));
    expect(roundTripped).toEqual(exported);

    const replay = await runFor(roundTripped, 70_000);
    expect(replay.eventLogHash()).toBe(live.eventLogHash());
  });
});
