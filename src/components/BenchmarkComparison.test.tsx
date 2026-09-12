import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchRun } from "../domain/benchmark";
import { BenchmarkComparison, buildComparisonRows } from "./BenchmarkComparison";

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function comparisonRun(overrides: Partial<BenchRun>): BenchRun {
  return {
    id: "run-1",
    status: "completed",
    benchmark: "humaneval",
    model: "model-one",
    providerName: "Provider One",
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
    config: { maxOutputTokens: 2048, thinkingEnabled: true, thinkingBudget: 1024 },
    comparison: {
      completePassCount: 1,
      completePassMeanScore: 0.5,
      loopingCount: 0,
      benchmarkMentionCount: 0,
      signalTotal: 2,
      activeDurationMilliseconds: 4_000,
      completePassLoopingCount: 0,
      completePassBenchmarkMentionCount: 0,
      completePassSignalTotal: 2,
      completePassActiveDurationMilliseconds: 4_000
    },
    ...overrides
  };
}

describe("benchmark comparison rows", () => {
  it("collapses configurations to the best result for each model and benchmark", () => {
    const rows = buildComparisonRows([
      comparisonRun({ id: "lower", meanScore: 0.5 }),
      comparisonRun({ id: "higher", meanScore: 0.75, config: { maxOutputTokens: 4096 } })
    ], ["humaneval"], true, false);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.get("humaneval")).toMatchObject({ score: 0.75, run: { id: "higher" } });
  });

  it("separates configurations and excludes runs without a complete pass", () => {
    const rows = buildComparisonRows([
      comparisonRun({ id: "complete" }),
      comparisonRun({
        id: "partial",
        completed: 1,
        meanScore: 1,
        config: { maxOutputTokens: 4096 },
        comparison: {
          completePassCount: 0,
          completePassMeanScore: null,
          loopingCount: 0,
          benchmarkMentionCount: 0,
          signalTotal: 1,
          activeDurationMilliseconds: 2_000,
          completePassLoopingCount: 0,
          completePassBenchmarkMentionCount: 0,
          completePassSignalTotal: 0,
          completePassActiveDurationMilliseconds: 0
        }
      })
    ], ["humaneval"], false, true);

    expect(rows).toHaveLength(1);
    expect(rows[0].cells.get("humaneval")?.run.id).toBe("complete");
  });

  it("shows configurable chart axes and switches back to the comparison table", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    render(<BenchmarkComparison runs={[comparisonRun({})]} onBack={() => undefined} />);

    expect(screen.getByRole("img", { name: /pareto chart/i })).toBeInTheDocument();
    const xAxis = screen.getByLabelText("X axis");
    const yAxis = screen.getByLabelText("Y axis");
    expect(xAxis).toHaveValue("taskTime");
    expect(yAxis).toHaveValue("score");

    await userEvent.selectOptions(xAxis, "looping");
    await userEvent.selectOptions(yAxis, "benchmarkMentions");
    expect(screen.getByRole("img", { name: /benchmark mention rate by looping rate/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});