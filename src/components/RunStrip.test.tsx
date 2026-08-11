import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchRun } from "../domain/benchmark";
import { RunStrip } from "./RunStrip";

afterEach(cleanup);

function benchmarkRun(id: string, benchmark: string, model: string): BenchRun {
  return {
    id,
    benchmark,
    model,
    status: "completed",
    baseUrl: "http://localhost:8000/v1",
    createdAt: "2026-08-12T10:00:00.000Z",
    total: 1,
    completed: 1,
    passed: 1,
    failed: 0,
    liveScore: 1,
    assertionsPassed: 1,
    assertionsTotal: 1,
    assertionScore: 1,
    currentTaskId: null,
    results: []
  };
}

describe("RunStrip", () => {
  it("filters runs by benchmark name and model", async () => {
    const runs = [
      benchmarkRun("human-qwen", "humaneval", "Qwen Coder"),
      benchmarkRun("mini-qwen", "bbeh-mini", "Qwen Reasoning"),
      benchmarkRun("mini-gemma", "bbeh-mini", "Gemma Reasoning")
    ];
    render(
      <RunStrip
        runs={runs}
        selectedRunId={null}
        onDelete={vi.fn()}
        onNavigate={vi.fn()}
        onRemoveFromQueue={vi.fn()}
        onSelectNew={vi.fn()}
      />
    );

    const benchmarkFilter = screen.getByRole("combobox", { name: "Filter by benchmark name" });
    await userEvent.click(benchmarkFilter);
    await userEvent.clear(benchmarkFilter);
    await userEvent.type(benchmarkFilter, "mini");
    await userEvent.click(screen.getByRole("option", { name: "BBEH Mini (corrected)" }));
    expect(screen.queryByText("Qwen Coder")).not.toBeInTheDocument();
    expect(screen.getByText("Qwen Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Gemma Reasoning")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("combobox", { name: "Filter by model" }), "gemma");
    expect(screen.queryByText("Qwen Reasoning")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Gemma ReasoningBBEH Mini/ })).toBeInTheDocument();
  });

  it("updates run progress and score when a live run advances", () => {
    const liveRun = {
      ...benchmarkRun("live-human", "humaneval", "Live Coder"),
      status: "running",
      total: 4,
      completed: 1,
      passed: 1,
      liveScore: 1
    };
    const properties = {
      selectedRunId: liveRun.id,
      onDelete: vi.fn(),
      onNavigate: vi.fn(),
      onRemoveFromQueue: vi.fn(),
      onSelectNew: vi.fn()
    };
    const { rerender } = render(<RunStrip {...properties} runs={[liveRun]} />);

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("1/4")).toBeInTheDocument();
    expect(screen.getByText("score 100%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Progress: 1 of 4 tasks, 100% score" })).toBeInTheDocument();

    const advancedRun = {
      ...liveRun,
      completed: 3,
      passed: 2,
      failed: 1,
      liveScore: 2 / 3
    };
    rerender(<RunStrip {...properties} runs={[advancedRun]} />);

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("3/4")).toBeInTheDocument();
    expect(screen.getByText("score 66.7%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Progress: 3 of 4 tasks, 66.7% score" })).toBeInTheDocument();
  });

  it("shows score and a checked indicator for completed graded benchmarks", () => {
    const gradedRun = {
      ...benchmarkRun("graded", "person-gender-name", "Graded Model"),
      meanScore: 0.42,
      liveScore: 0.9
    };

    render(
      <RunStrip
        runs={[gradedRun]}
        selectedRunId={gradedRun.id}
        onDelete={vi.fn()}
        onNavigate={vi.fn()}
        onRemoveFromQueue={vi.fn()}
        onSelectNew={vi.fn()}
      />
    );

    expect(screen.getByText("score 42%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Progress: 1 of 1 tasks, 42% score" })).toBeInTheDocument();
    expect(document.querySelector(".status-dot.completed svg")).toBeInTheDocument();
  });
});