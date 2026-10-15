/**
 * Runs every scenario in `simulator/scenarios/*.json` under each sync variant (named sets of the
 * library's sync knobs), as fast as possible,
 * prints a metrics table and writes `simulator/bench-results.json`. Exits non-zero when an
 * expectation fails.
 *
 *   pnpm sim:bench                 every scenario
 *   pnpm sim:bench late-joiner     scenarios whose name contains "late-joiner"
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Engine, type RunSummary } from "../src/engine/engine";
import {
  DEFAULT_VARIANTS,
  parseDuration,
  scenarioToRun,
  type Expectation,
  type Scenario,
} from "../src/engine/run";

const root = fileURLToPath(new URL("..", import.meta.url));
const filter = process.argv[2];

type BenchRow = {
  scenario: string;
  variant: string;
  wallMs: number;
  summary: RunSummary;
  failures: string[];
};

function check(
  summary: RunSummary,
  expectation: Expectation | undefined,
): string[] {
  if (!expectation) return [];
  const failures: string[] = [];
  if (
    expectation.lostByProtocol !== undefined &&
    summary.lostByProtocol > expectation.lostByProtocol
  ) {
    failures.push(
      `lostByProtocol ${summary.lostByProtocol} > ${expectation.lostByProtocol}`,
    );
  }
  if (expectation.convergedWithin !== undefined) {
    const limit = parseDuration(expectation.convergedWithin);
    if (
      summary.convergedWithinMs === null ||
      summary.convergedWithinMs > limit
    ) {
      failures.push(
        `converged ${summary.convergedWithinMs === null ? "never" : `in ${summary.convergedWithinMs / 1000} s`} (limit ${expectation.convergedWithin})`,
      );
    }
  }
  if (
    expectation.coverageMin !== undefined &&
    summary.coverageMin < expectation.coverageMin
  ) {
    failures.push(
      `coverageMin ${summary.coverageMin.toFixed(3)} < ${expectation.coverageMin}`,
    );
  }
  return failures;
}

function formatMs(milliseconds: number | null): string {
  if (milliseconds === null) return "-";
  return milliseconds < 1_000
    ? `${milliseconds}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;
}

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width);
}

async function main(): Promise<void> {
  const files = readdirSync(`${root}/scenarios`)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const rows: BenchRow[] = [];

  for (const file of files) {
    const scenario = JSON.parse(
      readFileSync(`${root}/scenarios/${file}`, "utf8"),
    ) as Scenario;
    if (filter && !scenario.name.includes(filter)) continue;
    for (const [variant, sync] of Object.entries(
      scenario.variants ?? DEFAULT_VARIANTS,
    )) {
      const started = performance.now();
      const engine = await Engine.create(scenarioToRun(scenario, sync), {
        routerLogLevel: "error",
        maxLogLines: 200,
      });
      await engine.advanceTo(parseDuration(scenario.runUntil));
      const summary = engine.summary();
      engine.dispose();
      const row: BenchRow = {
        scenario: scenario.name,
        variant,
        wallMs: Math.round(performance.now() - started),
        summary,
        failures: check(summary, scenario.expect?.[variant]),
      };
      rows.push(row);
      process.stderr.write(
        `  ${scenario.name} / ${variant}: ${row.wallMs} ms\n`,
      );
    }
  }

  const header = [
    pad("scenario", 22),
    pad("variant", 13),
    pad("items", 6, true),
    pad("cov min", 8, true),
    pad("lost", 6, true),
    pad("conv in", 8, true),
    pad("p50", 7, true),
    pad("p95", 8, true),
    pad("writes/item", 12, true),
    pad("KB/item", 8, true),
    pad("dup/item", 9, true),
    pad("confl", 6, true),
    "  check",
  ].join(" ");
  const lines = [header, "─".repeat(header.length)];
  for (const { scenario, variant, summary, failures } of rows) {
    lines.push(
      [
        pad(scenario, 22),
        pad(variant, 13),
        pad(String(summary.items), 6, true),
        pad(summary.coverageMin.toFixed(3), 8, true),
        pad(String(summary.lostByProtocol), 6, true),
        pad(
          summary.convergedWithinMs === null
            ? "never"
            : formatMs(summary.convergedWithinMs),
          8,
          true,
        ),
        pad(formatMs(summary.p50), 7, true),
        pad(formatMs(summary.p95), 8, true),
        pad(summary.writesPerItem.toFixed(1), 12, true),
        pad((summary.bytesPerItem / 1024).toFixed(1), 8, true),
        pad(summary.redundancy.toFixed(2), 9, true),
        pad(String(summary.conflicts), 6, true),
        failures.length === 0 ? "  ok" : `  ✗ ${failures.join("; ")}`,
      ].join(" "),
    );
  }
  process.stdout.write(`\n${lines.join("\n")}\n\n`);

  writeFileSync(
    `${root}/bench-results.json`,
    `${JSON.stringify(
      rows.map(({ scenario, variant, summary, failures }) => ({
        scenario,
        variant,
        ...summary,
        failures,
      })),
      null,
      2,
    )}\n`,
  );

  const failed = rows.filter((row) => row.failures.length > 0);
  if (failed.length > 0) {
    process.stderr.write(`${failed.length} expectation(s) failed.\n`);
    process.exitCode = 1;
  }
}

await main();
