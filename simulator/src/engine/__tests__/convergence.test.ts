import type { MeshSyncOptions } from "@sync/sync";
import { describe, expect, it } from "vitest";

import { Engine } from "../engine";
import { scenarioToRun, type Scenario } from "../run";

const lateJoiner: Scenario = {
  name: "late-joiner",
  seed: 42,
  preset: "late-joiner",
  // Scanning stops when the late device arrives, so convergence has a fixed target.
  actions: [{ at: "5m", do: "setParams", params: { scanRatePerMin: 0 } }],
  runUntil: "8m",
};

async function runLateJoiner(
  sync: MeshSyncOptions,
  itemBytes?: number,
): Promise<Engine> {
  const run = scenarioToRun(lateJoiner, sync);
  if (itemBytes !== undefined) run.config.params.itemBytes = itemBytes;
  const engine = await Engine.create(run, { routerLogLevel: "warn" });
  await engine.advanceTo(8 * 60_000);
  return engine;
}

describe("late joiner", () => {
  it("without repair, loses the items created before the late device arrived", async () => {
    const engine = await runLateJoiner({ repair: false });
    const summary = engine.summary();
    const late = engine.nodes.get("late")!;
    const beforeArrival = [...engine.metrics.items.values()].filter(
      (record) =>
        record.createdAt < 5 * 60_000 && record.authorDevice !== "late",
    );
    const missedByLate = beforeArrival.filter(
      (record) => !late.replica.has(record.item.tid),
    );
    expect(missedByLate.length).toBeGreaterThan(beforeArrival.length * 0.9);
    expect(summary.lostByProtocol).toBeGreaterThan(0);
    expect(summary.converged).toBe(false);
  });

  it("with the library defaults, converges within 30 s of the late device arriving", async () => {
    const summary = (await runLateJoiner({})).summary();
    process.stderr.write(`default ${JSON.stringify(summary)}\n`);
    expect(summary.lostByProtocol).toBe(0);
    expect(summary.converged).toBe(true);
    expect(summary.convergedWithinMs).not.toBeNull();
    expect(summary.convergedWithinMs!).toBeLessThanOrEqual(30_000);
  });

  it("converges with multi-part items too (2 KB scans)", async () => {
    const summary = (await runLateJoiner({}, 2_000)).summary();
    process.stderr.write(`2KB ${JSON.stringify(summary)}\n`);
    expect(summary.lostByProtocol).toBe(0);
    expect(summary.converged).toBe(true);
  });
});
