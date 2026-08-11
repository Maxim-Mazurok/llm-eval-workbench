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
});