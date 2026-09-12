import { describe, expect, it } from "vitest";
import type { BenchRun } from "./benchmark";
import { aggregateComparisonMetric, comparisonMetricDomain, paretoFrontier, type ComparisonChartPoint } from "./comparisonChart";

function runWithMetrics(): BenchRun {
  return {
    id: "run-one",
    status: "completed",
    model: "model-one",
    baseUrl: "http://localhost:8000/v1",
    createdAt: "2026-06-16T00:00:00.000Z",
    total: 2,
    completed: 2,
    passed: 1,
    failed: 1,
    liveScore: 0.5,
    assertionsPassed: 1,
    assertionsTotal: 2,
    assertionScore: 0.5,
    currentTaskId: null,
    results: [],
    comparison: {
      completePassCount: 1,
      completePassMeanScore: 0.5,
      loopingCount: 1,
      benchmarkMentionCount: 1,
      signalTotal: 3,
      activeDurationMilliseconds: 9_000,
      completePassLoopingCount: 0,
      completePassBenchmarkMentionCount: 1,
      completePassSignalTotal: 2,
      completePassActiveDurationMilliseconds: 4_000
    }
  };
}

describe("comparison chart metrics", () => {
  it("keeps percentage axes within zero and one hundred percent", () => {
    expect(comparisonMetricDomain([0.84, 0.98], "score")).toEqual([0.826, 0.994]);
    expect(comparisonMetricDomain([0.84, 1], "score")).toEqual([0.824, 1]);
    expect(comparisonMetricDomain([0, 0], "looping")).toEqual([0, 0.1]);
  });

  it("uses only complete-pass attempts when requested", () => {
    const sources = [{ run: runWithMetrics(), score: 0.5 }];

    expect(aggregateComparisonMetric(sources, "taskTime", true)).toBe(2_000);
    expect(aggregateComparisonMetric(sources, "taskTime", false)).toBe(3_000);
    expect(aggregateComparisonMetric(sources, "looping", true)).toBe(0);
    expect(aggregateComparisonMetric(sources, "looping", false)).toBeCloseTo(1 / 3);
  });

  it("treats absent timing measurements as unavailable", () => {
    const run = runWithMetrics();
    run.comparison!.completePassActiveDurationMilliseconds = 0;

    expect(aggregateComparisonMetric([{ run, score: 0.5 }], "taskTime", true)).toBeNull();
  });

  it("finds frontier when time is lower and score is higher", () => {
    const point = (id: string, xValue: number, yValue: number): ComparisonChartPoint => ({
      id,
      label: id,
      provider: "provider",
      xValue,
      yValue
    });
    const points = [
      point("fast-low", 1, 0.5),
      point("balanced", 2, 0.8),
      point("slow-low", 3, 0.7),
      point("slow-high", 4, 0.9)
    ];

    expect(paretoFrontier(points, false, true).map((candidate) => candidate.id)).toEqual([
      "fast-low",
      "balanced",
      "slow-high"
    ]);
  });

  it("supports two lower-is-better red-flag axes", () => {
    const points: ComparisonChartPoint[] = [
      { id: "clean", label: "Clean", provider: "one", xValue: 0, yValue: 0, },
      { id: "mixed", label: "Mixed", provider: "two", xValue: 0.1, yValue: 0.2 },
      { id: "tradeoff", label: "Tradeoff", provider: "three", xValue: 0, yValue: 0.3 }
    ];

    expect(paretoFrontier(points, false, false).map((candidate) => candidate.id)).toEqual(["clean"]);
  });
});