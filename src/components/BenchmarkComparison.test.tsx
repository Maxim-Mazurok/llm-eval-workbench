import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchRoute, BenchRun } from "../domain/benchmark";
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

function ComparisonHarness({ runs }: { runs: BenchRun[] }) {
  const [route, setRoute] = useState<Extract<BenchRoute, { view: "comparison" }>>({ view: "comparison" });
  return <BenchmarkComparison runs={runs} route={route} onBack={() => undefined} onRouteChange={setRoute} />;
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

  it("excludes outdated results unless the filter is disabled", () => {
    const runs = [comparisonRun({ id: "outdated", benchmarkDataOutdated: true })];

    expect(buildComparisonRows(runs, ["humaneval"], false, true)).toHaveLength(0);
    expect(buildComparisonRows(runs, ["humaneval"], false, true, false)).toHaveLength(1);
  });

  it("shows configurable chart axes and switches back to the comparison table", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    render(<ComparisonHarness runs={[comparisonRun({})]} />);

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

  it("reports filter, checkbox, and view changes through comparison route state", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const onRouteChange = vi.fn();
    render(
      <BenchmarkComparison
        runs={[comparisonRun({}), comparisonRun({ id: "run-2", model: "model-two", benchmark: "bbeh" })]}
        route={{ view: "comparison" }}
        onBack={() => undefined}
        onRouteChange={onRouteChange}
      />
    );

    await userEvent.click(screen.getByText("Models"));
    await userEvent.click(screen.getByRole("checkbox", { name: "model-two" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "comparison", selectedModels: ["model-one"] });

    await userEvent.click(screen.getByRole("checkbox", { name: "Only best model result" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "comparison", onlyBestModelResult: false });

    await userEvent.click(screen.getByRole("checkbox", { name: "Ignore outdated results" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "comparison", ignoreOutdatedResults: false });

    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "comparison", comparisonView: "table" });
  });

  it("closes filters when another filter or control is activated", async () => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    render(<ComparisonHarness runs={[comparisonRun({}), comparisonRun({ id: "run-2", model: "model-two", benchmark: "bbeh" })]} />);
    const benchmarksTrigger = screen.getByRole("button", { name: /Benchmarks/ });
    const modelsTrigger = screen.getByRole("button", { name: /Models/ });

    await userEvent.click(benchmarksTrigger);
    expect(benchmarksTrigger).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(modelsTrigger);
    expect(benchmarksTrigger).toHaveAttribute("aria-expanded", "false");
    expect(modelsTrigger).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(screen.getByRole("checkbox", { name: "Only best model result" }));
    expect(modelsTrigger).toHaveAttribute("aria-expanded", "false");
  });
});