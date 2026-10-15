import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { MetricSample } from "../engine/metrics";

export type ChartRun = { name: string; samples: MetricSample[] };

type SeriesSpec = {
  label: string;
  color: string;
  value: (sample: MetricSample) => number | null;
};

type ChartSpec = {
  title: string;
  series: SeriesSpec[];
  log?: boolean;
  unit?: (value: number) => string;
};

const CHARTS: ChartSpec[] = [
  {
    title: "Coverage",
    series: [
      {
        label: "mean",
        color: "#22a35a",
        value: (sample) => sample.coverageMean * 100,
      },
      {
        label: "min",
        color: "#86d3a5",
        value: (sample) => sample.coverageMin * 100,
      },
    ],
    unit: (value) => `${value.toFixed(0)}%`,
  },
  {
    title: "Writes / s",
    series: [
      {
        label: "writes/s",
        color: "#3b82f6",
        value: (sample) => sample.writesPerSec,
      },
    ],
    unit: (value) => value.toFixed(0),
  },
  {
    title: "Propagation",
    series: [
      { label: "p50", color: "#8b5cf6", value: (sample) => sample.p50 },
      { label: "p95", color: "#c4b5fd", value: (sample) => sample.p95 },
    ],
    log: true,
    unit: (value) =>
      value >= 1000
        ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`
        : `${value.toFixed(0)}ms`,
  },
  {
    title: "Missing",
    series: [
      {
        label: "lost (≥30 s)",
        color: "#dc2626",
        value: (sample) => sample.lostByProtocol,
      },
      {
        label: "missing w/ path",
        color: "#f59e0b",
        value: (sample) => sample.missingWithPath,
      },
    ],
    unit: (value) => value.toFixed(0),
  },
  {
    title: "Conflicts",
    series: [
      {
        label: "double admissions",
        color: "#e11d48",
        value: (sample) => sample.conflicts,
      },
    ],
    unit: (value) => value.toFixed(0),
  },
];

function buildData(runs: ChartRun[], chart: ChartSpec): uPlot.AlignedData {
  // Runs advance in lockstep, so the first run's timestamps index all of them.
  const base = runs[0]?.samples ?? [];
  const xs = base.map((sample) => sample.t / 1000);
  const columns: (number | null)[][] = [];
  for (const run of runs) {
    const byTime = new Map(run.samples.map((sample) => [sample.t, sample]));
    for (const series of chart.series) {
      columns.push(
        base.map((sample) => {
          const match = byTime.get(sample.t);
          const value = match ? series.value(match) : null;
          // Log charts plot log10 on a linear scale (uPlot's log distribution is fragile with gaps).
          if (chart.log)
            return value !== null && value > 0 ? Math.log10(value) : null;
          return value;
        }),
      );
    }
  }
  return [xs, ...columns] as uPlot.AlignedData;
}

function Chart({ chart, runs }: { chart: ChartSpec; runs: ChartRun[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const shapeRef = useRef("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const shape = runs.map((run) => run.name).join("|");
    if (plotRef.current && shapeRef.current === shape) {
      plotRef.current.setData(buildData(runs, chart));
      return;
    }
    plotRef.current?.destroy();
    shapeRef.current = shape;
    const muted = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-muted")
      .trim();
    const grid = getComputedStyle(document.documentElement)
      .getPropertyValue("--border")
      .trim();
    const axis: uPlot.Axis = {
      stroke: muted,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: "10px system-ui, sans-serif",
    };
    const display = (value: number) =>
      chart.log ? Math.pow(10, value) : value;
    const series: uPlot.Series[] = [
      {
        label: "t",
        value: (_plot, value) =>
          value === null ? "–" : `${value.toFixed(0)} s`,
      },
    ];
    runs.forEach((run, runIndex) => {
      for (const spec of chart.series) {
        series.push({
          label: runs.length > 1 ? `${run.name} ${spec.label}` : spec.label,
          stroke: spec.color,
          width: 1.6,
          dash: runIndex === 1 ? [6, 4] : undefined,
          spanGaps: true,
          points: { show: false },
          value: (_plot, value) =>
            value === null
              ? "–"
              : (chart.unit?.(display(value)) ?? String(display(value))),
        });
      }
    });
    plotRef.current = new uPlot(
      {
        width: container.clientWidth,
        height: Math.max(80, container.clientHeight - 28),
        series,
        scales: {
          x: { time: false },
          y: chart.log
            ? {
                range: (_plot, min, max) => [
                  Math.max(0, Math.floor(min ?? 0)),
                  Math.max(1, Math.ceil(max ?? 1)),
                ],
              }
            : {
                range: (_plot, min, max) => [
                  Math.min(0, min ?? 0),
                  Math.max(1, max ?? 1),
                ],
              },
        },
        axes: [
          {
            ...axis,
            values: (_plot, ticks) =>
              ticks.map((tick) => `${Math.round(tick)}s`),
          },
          {
            ...axis,
            size: 44,
            ...(chart.log ? { incrs: [1] } : {}),
            values: (_plot, ticks) =>
              ticks.map((tick) =>
                chart.unit ? chart.unit(display(tick)) : String(display(tick)),
              ),
          },
        ],
        legend: { show: true, live: true },
        cursor: { drag: { x: false, y: false } },
      },
      buildData(runs, chart),
      container,
    );
  }, [runs, chart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      plotRef.current?.setSize({
        width: container.clientWidth,
        height: Math.max(80, container.clientHeight - 28),
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, []);

  return (
    <div className="chart">
      <div className="chart-title">{chart.title}</div>
      <div className="chart-body" ref={containerRef} />
    </div>
  );
}

export function Charts({ runs }: { runs: ChartRun[] }) {
  return (
    <section className="charts">
      {CHARTS.map((chart) => (
        <Chart key={chart.title} chart={chart} runs={runs} />
      ))}
    </section>
  );
}
