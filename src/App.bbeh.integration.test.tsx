import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { BBEH_PROMPT_TEMPLATE, BBEH_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT } from "./domain/benchmark";

type RunFixture = Record<string, unknown>;

const bbehResultPassed = {
  taskId: "bbeh_mini/0",
  attemptId: "bbeh_mini/0::pass-1",
  passNumber: 1,
  passTotal: 1,
  index: 0,
  entryPoint: undefined,
  subtask: "causal_understanding",
  passed: true,
  tests: [{
    source: "final answer matches target (official BBEH fuzzy match)",
    passed: true,
    actual: "yes",
    expected: "yes",
    operator: "fuzzy=="
  }],
  prompt: "Is water wet? Reply Yes or No.",
  test: "Expected answer: Yes",
  instructionPrompt: "SYSTEM:\nsys\n\nUSER:\nIs water wet?",
  rawOutput: "Let me think. The answer is: yes.",
  extractedCode: "yes",
  expectedAnswer: "Yes",
  generationMs: 100,
  activeDurationMilliseconds: 100
};

const bbehResultFailed = {
  ...bbehResultPassed,
  taskId: "bbeh_mini/1",
  attemptId: "bbeh_mini/1::pass-1",
  index: 1,
  subtask: "time_arithmetic",
  passed: false,
  tests: [{
    source: "final answer matches target (official BBEH fuzzy match)",
    passed: false,
    actual: "8",
    expected: "7",
    operator: "fuzzy=="
  }],
  prompt: "What is 3 + 4?",
  test: "Expected answer: 7",
  rawOutput: "The answer is: 8.",
  extractedCode: "8",
  expectedAnswer: "7"
};

const bbehRun = (overrides: RunFixture = {}): RunFixture => ({
  id: "bbeh-run-1",
  status: "completed",
  benchmark: "bbeh-mini",
  benchmarkDataRevision: "80d12ca+linguini-single-blank-v1",
  model: "demo-model",
  createdAt: "2026-06-16T00:00:00.000Z",
  startedAt: "2026-06-16T00:00:00.000Z",
  finishedAt: "2026-06-16T00:00:03.000Z",
  total: 2,
  completed: 2,
  passed: 1,
  failed: 1,
  liveScore: 0.5,
  finalScore: 0.5,
  assertionsPassed: 1,
  assertionsTotal: 2,
  assertionScore: 0.5,
  currentTaskId: null,
  activeTaskIds: [],
  config: {
    benchmark: "bbeh-mini",
    model: "demo-model",
    baseUrl: "http://localhost:8000/v1",
    passCount: 1,
    systemPrompt: BBEH_SYSTEM_PROMPT,
    promptTemplate: BBEH_PROMPT_TEMPLATE
  },
  results: [bbehResultPassed, bbehResultFailed],
  ...overrides
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  }));
}

describe("App bbeh benchmark", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    });
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FakeEventSource
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("switches prompts to BBEH defaults and posts the benchmark id", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return jsonResponse(bbehRun({ status: "queued", completed: 0, passed: 0, failed: 0, results: [] }), 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse({ ...bbehRun({ status: "queued", results: [] }), events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const systemPromptField = screen.getByLabelText("System prompt") as HTMLTextAreaElement;
    expect(systemPromptField.value).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(screen.getByText(/Executes model-generated Python locally/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Benchmark" }));
    await userEvent.click(screen.getByRole("option", { name: "BBEH Mini (corrected)" }));

    expect(systemPromptField.value).toBe(BBEH_SYSTEM_PROMPT);
    expect((screen.getByLabelText("Prompt template") as HTMLTextAreaElement).value).toContain("%problem%");
    expect(screen.queryByText(/Executes model-generated Python locally/)).not.toBeInTheDocument();
    expect(screen.getAllByText("BBEH Mini (corrected)").length).toBeGreaterThan(0);

    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      benchmark: "bbeh-mini",
      model: "demo-model",
      systemPrompt: BBEH_SYSTEM_PROMPT
    });
  });

  it("takes a pack benchmark's system prompt from the server registry", async () => {
    const datasetSystemPrompt = "prompt exported with the person-props dataset";
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/benchmarks")) {
        return jsonResponse({
          benchmarks: [{ id: "person-props-age-photos", defaultSystemPrompt: datasetSystemPrompt }]
        });
      }
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return jsonResponse({ id: "pp-run-1", status: "queued", results: [] }, 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse({ runs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const systemPromptField = screen.getByLabelText("System prompt") as HTMLTextAreaElement;
    await userEvent.click(screen.getByRole("combobox", { name: "Benchmark" }));
    await userEvent.click(screen.getByRole("option", { name: "Person Props: Age from photos only (vision)" }));
    await waitFor(() => expect(systemPromptField.value).toBe(datasetSystemPrompt));

    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      benchmark: "person-props-age-photos",
      systemPrompt: datasetSystemPrompt
    });
  });

  it("renders answer-oriented labels and subtasks for a bbeh run", async () => {
    const run = bbehRun();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/run/bbeh-run-1");

    render(<App />);

    await screen.findByText("bbeh_mini/0");
    expect(screen.getByText(/causal_understanding/)).toBeInTheDocument();
    expect(screen.getByText(/time_arithmetic/)).toBeInTheDocument();
    expect(screen.getByText("BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1")).toBeInTheDocument();

    // The qa metrics drop code-only panels and rename assertion labels.
    expect(screen.getAllByText("Answer checks").length).toBeGreaterThan(0);
    expect(screen.queryByText("Thinking in comments")).not.toBeInTheDocument();
    expect(screen.getByText("1/2 (50%)")).toBeInTheDocument();

    await userEvent.click(screen.getByText("bbeh_mini/1"));
    expect(screen.getAllByText("Answer check").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Extracted answer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Expected answer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Task input").length).toBeGreaterThan(0);
    expect(screen.queryByText("Assert ledger")).not.toBeInTheDocument();
    expect(screen.queryByText("HumanEval tests")).not.toBeInTheDocument();
    const failedCheck = screen.getAllByText(/FAIL final answer matches target/)[0];
    expect(failedCheck.textContent).toContain("expected: 7");
    expect(failedCheck.textContent).toContain("actual:   8");
  });

  it("loads BBEH config from a run tab and resets to HumanEval on new bench", async () => {
    const run = bbehRun();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/run/bbeh-run-1");

    render(<App />);

    const benchmarkCombobox = await screen.findByLabelText("Benchmark") as HTMLInputElement;
    await waitFor(() => expect(benchmarkCombobox.value).toBe("BBEH Mini (corrected)"));
    expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(BBEH_SYSTEM_PROMPT);

    await userEvent.click(screen.getByRole("button", { name: /new bench/i }));

    await waitFor(() => expect(benchmarkCombobox.value).toBe("HumanEval (code)"));
    expect((screen.getByLabelText("System prompt") as HTMLTextAreaElement).value).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
