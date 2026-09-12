import type { BenchRun } from "./benchmark";

export type ComparisonMetricId = "score" | "taskTime" | "looping" | "benchmarkMentions";

export type ComparisonMetric = {
  id: ComparisonMetricId;
  label: string;
  shortLabel: string;
  higherIsBetter: boolean;
  format: (value: number) => string;
};

export type ComparisonMetricSource = {
  run: BenchRun;
  score: number;
};

export type ComparisonChartPoint = {
  id: string;
  label: string;
  provider: string;
  xValue: number;
  yValue: number;
};

function formatPercentage(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatTaskTime(value: number) {
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export const COMPARISON_METRICS: ComparisonMetric[] = [
  { id: "score", label: "Mean benchmark score", shortLabel: "Score", higherIsBetter: true, format: formatPercentage },
  { id: "taskTime", label: "Average time per task", shortLabel: "Time / task", higherIsBetter: false, format: formatTaskTime },
  { id: "looping", label: "Looping rate", shortLabel: "Looping", higherIsBetter: false, format: formatPercentage },
  { id: "benchmarkMentions", label: "Benchmark mention rate", shortLabel: "Mentions", higherIsBetter: false, format: formatPercentage }
];

export function comparisonMetric(metricId: ComparisonMetricId) {
  return COMPARISON_METRICS.find((metric) => metric.id === metricId) ?? COMPARISON_METRICS[0];
}

export function comparisonMetricDomain(values: number[], metricId: ComparisonMetricId) {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;
  const padding = span > 0 ? span * 0.1 : Math.max(Math.abs(maximum) * 0.1, 0.1);
  const domainMinimum = Math.max(0, minimum - padding);
  const domainMaximum = maximum + padding;
  return metricId === "taskTime"
    ? [domainMinimum, domainMaximum] as const
    : [domainMinimum, Math.min(1, domainMaximum)] as const;
}

function sourceMetrics(source: ComparisonMetricSource, ignoreIncompletePasses: boolean) {
  const comparison = source.run.comparison;
  if (!comparison) return null;
  const signalTotal = ignoreIncompletePasses
    ? comparison.completePassSignalTotal ?? 0
    : comparison.signalTotal;
  if (!signalTotal) return null;
  const activeDurationMilliseconds = ignoreIncompletePasses
    ? comparison.completePassActiveDurationMilliseconds ?? 0
    : comparison.activeDurationMilliseconds ?? 0;
  return {
    score: source.score,
    taskTime: activeDurationMilliseconds > 0 ? activeDurationMilliseconds / signalTotal : null,
    looping: (ignoreIncompletePasses
      ? comparison.completePassLoopingCount ?? 0
      : comparison.loopingCount) / signalTotal,
    benchmarkMentions: (ignoreIncompletePasses
      ? comparison.completePassBenchmarkMentionCount ?? 0
      : comparison.benchmarkMentionCount) / signalTotal,
    weight: signalTotal
  };
}

export function aggregateComparisonMetric(
  sources: ComparisonMetricSource[],
  metricId: ComparisonMetricId,
  ignoreIncompletePasses: boolean
) {
  const metrics = sources.map((source) => sourceMetrics(source, ignoreIncompletePasses)).filter((value) => value !== null);
  const availableMetrics = metrics.flatMap((metric) => {
    const value = metric[metricId];
    return typeof value === "number" && Number.isFinite(value) ? [{ value, weight: metric.weight }] : [];
  });
  if (!availableMetrics.length) return null;
  const totalWeight = availableMetrics.reduce((total, metric) => total + metric.weight, 0);
  if (!totalWeight) return null;
  return availableMetrics.reduce((total, metric) => total + metric.value * metric.weight, 0) / totalWeight;
}

function noWorse(left: number, right: number, higherIsBetter: boolean) {
  return higherIsBetter ? left >= right : left <= right;
}

function strictlyBetter(left: number, right: number, higherIsBetter: boolean) {
  return higherIsBetter ? left > right : left < right;
}

export function paretoFrontier(
  points: ComparisonChartPoint[],
  xHigherIsBetter: boolean,
  yHigherIsBetter: boolean
) {
  return points.filter((candidate) => !points.some((other) => (
    other.id !== candidate.id
    && noWorse(other.xValue, candidate.xValue, xHigherIsBetter)
    && noWorse(other.yValue, candidate.yValue, yHigherIsBetter)
    && (
      strictlyBetter(other.xValue, candidate.xValue, xHigherIsBetter)
      || strictlyBetter(other.yValue, candidate.yValue, yHigherIsBetter)
    )
  )));
}