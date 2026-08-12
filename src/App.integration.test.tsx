import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

type RunFixture = {
  id: string;
  status: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  liveScore: number;
  finalScore?: number | null;
  assertionsPassed: number;
  assertionsTotal: number;
  assertionScore: number;
  currentTaskId: string | null;
  queuedAt?: string | null;
  queuePosition?: number | null;
  selectedIndices?: number[];
  config?: Record<string, unknown>;
  activeTaskIds?: string[];
  activeTaskStartedAt?: Record<string, string>;
  results: Array<Record<string, unknown>>;
};

const baseRun = (overrides: Partial<RunFixture> = {}): RunFixture => ({
  id: "run-1",
  status: "queued",
  model: "demo-model",
  baseUrl: "http://localhost:8000/v1",
  createdAt: "2026-06-16T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  total: 2,
  completed: 0,
  passed: 0,
  failed: 0,
  liveScore: 0,
  finalScore: null,
  assertionsPassed: 0,
  assertionsTotal: 0,
  assertionScore: 0,
  currentTaskId: null,
  activeTaskIds: [],
  results: [],
  ...overrides
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  listeners = new Map<string, Array<(message: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const message = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) || []) listener(message);
  }
}

function installNotificationMock() {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn(async () => "granted" as NotificationPermission);

    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
  }
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  }));
}

describe("App notifications", () => {
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
    window.localStorage.clear();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FakeEventSource
    });
  });

  afterEach(() => {
    cleanup();
    delete window.llmEvalPerformanceMetrics;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("notifies when an enabled run receives a done SSE event", async () => {
    const notificationCalls = installNotificationMock();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return jsonResponse(baseRun({ status: "queued" }), 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse(baseRun({ events: [] } as Partial<RunFixture>));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0].emit("done", {
      type: "done",
      at: "2026-06-16T00:00:03.000Z",
      data: {
        summary: baseRun({
          status: "completed",
          completed: 2,
          passed: 2,
          liveScore: 1,
          finalScore: 1,
          finishedAt: "2026-06-16T00:00:03.000Z"
        })
      }
    });

    await waitFor(() => expect(notificationCalls).toHaveLength(1));
    expect(notificationCalls[0]).toMatchObject({
      title: "HumanEval run finished",
      options: { body: "demo-model · 2/2 passed · completed", tag: "run-1" }
    });
  });

  it("notifies after an SSE error when refresh finds an observed run completed", async () => {
    const notificationCalls = installNotificationMock();
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        listCalls += 1;
        const run = listCalls === 1
          ? baseRun({ status: "running", completed: 1, passed: 1, activeTaskIds: ["HumanEval/1"] })
          : baseRun({
              status: "completed",
              completed: 2,
              passed: 2,
              liveScore: 1,
              finalScore: 1,
              finishedAt: "2026-06-16T00:00:03.000Z"
            });
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...baseRun({ status: "running" }), events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    FakeEventSource.instances[0].onerror?.();

    await waitFor(() => expect(notificationCalls).toHaveLength(1));
    expect(notificationCalls[0].options?.body).toBe("demo-model · 2/2 passed · completed");
  });

  it("keeps new bench selected by default and resets parameters from a run tab", async () => {
    const runWithConfig = baseRun({
      status: "completed",
      model: "saved-model",
      config: {
        baseUrl: "http://saved.example/v1",
        model: "saved-model",
        apiKey: "sk-live-secret",
        maxOutputTokens: 4096,
        timeoutSeconds: 60,
        parallelTasks: 8,
        sampleLimit: 12,
        startIndex: 9,
        testNumbers: "1, 2",
        systemPrompt: "saved system",
        promptTemplate: "saved template %problem_code%",
        extraBody: { top_p: 0.5 }
      }
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runWithConfig] });
      }
      return jsonResponse({ ...runWithConfig, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(window.location.pathname).toBe("/new");

    const modelInput = await screen.findByPlaceholderText("provider/model-name");
    expect(modelInput).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("Local model server"));

    await userEvent.click(screen.getByRole("button", { name: /completed.*saved-model|saved-model.*completed/i }));
    await waitFor(() => expect(modelInput).toHaveValue("saved-model"));
    expect(window.location.pathname).toBe("/run/run-1");
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("Local model server");

    await userEvent.click(screen.getByRole("button", { name: /new bench/i }));
    expect(window.location.pathname).toBe("/new");
    expect(modelInput).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("Local model server");
    const extraBodyField = screen.getByText("Extra request body").closest("label")?.querySelector("textarea");
    expect(extraBodyField).toHaveValue("{\n  \"top_p\": 1\n}");
  });

  it("posts the normalized benchmark configuration when starting a run", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        return jsonResponse(baseRun({ status: "queued", config: { model: "configured-model" } }), 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse({ ...baseRun({ status: "queued" }), events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "configured-model");
    await userEvent.clear(screen.getByLabelText("Parallel"));
    await userEvent.type(screen.getByLabelText("Parallel"), "99");
    await userEvent.clear(screen.getByLabelText("Passes"));
    await userEvent.type(screen.getByLabelText("Passes"), "101");
    await userEvent.clear(screen.getByLabelText("System prompt"));
    await userEvent.type(screen.getByLabelText("System prompt"), "system");
    await userEvent.clear(screen.getByLabelText("Prompt template"));
    await userEvent.type(screen.getByLabelText("Prompt template"), "prompt %problem_code%");
    await userEvent.click(screen.getByLabelText("Abort loops and adapt repetition penalty"));
    fireEvent.change(screen.getByLabelText("Extra request body"), { target: { value: "{\"top_p\":0.25}" } });

    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      model: "configured-model",
      parallelTasks: 1,
      passCount: 100,
      adaptiveRepetitionPenalty: true,
      systemPrompt: "system",
      promptTemplate: "prompt %problem_code%",
      temperature: 0,
      extraBody: { top_p: 0.25 }
    });
  });

  it("shows and copies looping tasks separately", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const repeatedCycle = "Wait, let's look at the points: (-10.12, 71.09) (-9.42, 66.06)";
    const thinkingOutput = Array.from({ length: 6 }, () => repeatedCycle).join("\n");
    const occurrences = Array.from({ length: 6 }, (_, index) => {
      const start = index * (repeatedCycle.length + 1);
      return { start, end: start + repeatedCycle.length };
    });
    const clipboardWrite = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite }
    });
    const loopingRun = baseRun({
      status: "completed",
      total: 1,
      completed: 1,
      failed: 1,
      config: { adaptiveRepetitionPenalty: true },
      results: [{
        taskId: "HumanEval/7",
        attemptId: "HumanEval/7::pass-1",
        passNumber: 1,
        passTotal: 1,
        index: 7,
        entryPoint: "looping_task",
        passed: false,
        looping: true,
        repetitionPenalty: 1,
        loopDetection: {
          channel: "thinking",
          repetitions: 6,
          patternWords: 42,
          matchedWords: 252,
          excerpt: "repeated reasoning",
          occurrences
        },
        tests: [{
          source: "assert looping_task()",
          passed: false
        }],
        prompt: "def looping_task(): pass",
        test: "assert looping_task()",
        rawOutput: "",
        thinkingOutput,
        extractedCode: ""
      }]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [loopingRun] });
      return jsonResponse({ ...loopingRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    const taskButton = await screen.findByRole("button", { name: /HumanEval\/7/i });
    const taskBadges = taskButton.querySelector(".status-badges");
    expect(taskBadges).toHaveTextContent("failloop");
    expect(within(taskButton).getByText("fail")).toHaveClass("fail-pill");
    expect(within(taskButton).getByText("loop")).toHaveClass("loop-pill");
    expect(screen.getByText("Looping")).toBeInTheDocument();
    await userEvent.click(taskButton);
    expect(container.querySelectorAll(".loop-highlight")).toHaveLength(6);
    expect(screen.getByText("Loop 1 start")).toBeInTheDocument();
    expect(screen.getByText("Loop 6 end")).toBeInTheDocument();
    expect(container.querySelector(".loop-highlight")?.textContent).toContain("Wait, let's look at the points");
    expect(screen.getByText(/Generation stopped early\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy looping" }));
    expect(clipboardWrite).toHaveBeenCalledWith("7");
  });

  it("labels a failed detected loop when generation was allowed to finish", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const recoveredRun = baseRun({
      status: "completed",
      total: 1,
      completed: 1,
      failed: 1,
      config: { adaptiveRepetitionPenalty: false },
      results: [{
        taskId: "HumanEval/7",
        attemptId: "HumanEval/7::pass-1",
        passNumber: 1,
        passTotal: 1,
        index: 7,
        entryPoint: "recovered_task",
        passed: false,
        loopDetection: {
          channel: "thinking",
          repetitions: 5,
          patternWords: 45,
          matchedWords: 225,
          excerpt: "repeated reasoning"
        },
        tests: [{ source: "assert recovered_task()", passed: false }],
        prompt: "def recovered_task(): return True",
        test: "assert recovered_task()",
        rawOutput: "```python\ndef recovered_task(): return True\n```",
        thinkingOutput: "repeated reasoning",
        extractedCode: "def recovered_task(): return True"
      }]
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [recoveredRun] });
      return jsonResponse({ ...recoveredRun, events: [] });
    }));

    render(<App />);

    const taskButton = await screen.findByRole("button", { name: /HumanEval\/7/i });
    expect(taskButton.querySelector(".status-badges")).toHaveTextContent("failloop");
    await userEvent.click(taskButton);
    expect(await screen.findByText(/Generation continued to its normal finish\./)).toBeInTheDocument();
    expect(screen.queryByText(/Generation stopped early\./)).not.toBeInTheDocument();
  });

  it("keeps a passing answer passed when generation stopped after a loop", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const passingLoopRun = baseRun({
      status: "completed",
      total: 1,
      completed: 1,
      passed: 1,
      results: [{
        taskId: "bbeh_mini/5",
        attemptId: "bbeh_mini/5::pass-1",
        passNumber: 1,
        passTotal: 1,
        index: 5,
        entryPoint: "",
        subtask: "mini",
        passed: true,
        looping: true,
        loopDetection: {
          channel: "thinking",
          repetitions: 64,
          patternWords: 34,
          matchedWords: 2_176,
          excerpt: "repeated reasoning"
        },
        tests: [{ source: "final answer matches target", passed: true }],
        prompt: "Task input",
        test: "Expected answer: 5",
        rawOutput: "The answer is: 5",
        thinkingOutput: "repeated reasoning",
        extractedCode: "5"
      }]
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [passingLoopRun] });
      return jsonResponse({ ...passingLoopRun, events: [] });
    }));

    render(<App />);

    const taskButton = await screen.findByRole("button", { name: /bbeh_mini\/5/i });
    expect(taskButton.querySelector(".status-badges")).toHaveTextContent("passloop");
    expect(within(taskButton).getByText("pass")).toHaveClass("pass-pill");
    expect(within(taskButton).getByText("loop")).toHaveClass("loop-pill");
  });

  it("shows penalties for every completed adaptive task status", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const resultBase = {
      passNumber: 1,
      passTotal: 1,
      entryPoint: "task",
      prompt: "def task(): pass",
      test: "assert task()",
      rawOutput: "",
      extractedCode: "",
      activeDurationMilliseconds: 1_000
    };
    const adaptiveRun = baseRun({
      status: "completed",
      total: 4,
      completed: 4,
      passed: 1,
      failed: 3,
      config: { adaptiveRepetitionPenalty: true },
      results: [
        { ...resultBase, taskId: "HumanEval/0", index: 0, passed: true, repetitionPenalty: 1.01, tests: [] },
        { ...resultBase, taskId: "HumanEval/1", index: 1, passed: false, repetitionPenalty: 1.02, tests: [{ source: "assert task()", passed: false }] },
        { ...resultBase, taskId: "HumanEval/2", index: 2, passed: false, repetitionPenalty: 1.03, tests: [], modelError: "Request failed" },
        { ...resultBase, taskId: "HumanEval/3", index: 3, passed: false, repetitionPenalty: 1.04, tests: [], looping: true }
      ]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [adaptiveRun] });
      return jsonResponse({ ...adaptiveRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("button", { name: /HumanEval\/0/i })).toHaveTextContent("penalty 1.01");
    expect(screen.getByRole("button", { name: /HumanEval\/1/i })).toHaveTextContent("penalty 1.02");
    expect(screen.getByRole("button", { name: /HumanEval\/2/i })).toHaveTextContent("penalty 1.03");
    expect(screen.getByRole("button", { name: /HumanEval\/3/i })).toHaveTextContent("penalty 1.04");
  });

  it("hides result penalties for non-adaptive runs", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const nonAdaptiveRun = baseRun({
      status: "completed",
      total: 1,
      completed: 1,
      failed: 1,
      config: { adaptiveRepetitionPenalty: false },
      results: [{
        taskId: "HumanEval/2",
        index: 2,
        entryPoint: "task",
        passed: false,
        repetitionPenalty: 1.03,
        tests: [],
        modelError: "Request failed",
        prompt: "def task(): pass",
        test: "assert task()",
        rawOutput: "",
        extractedCode: ""
      }]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [nonAdaptiveRun] });
      return jsonResponse({ ...nonAdaptiveRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("button", { name: /HumanEval\/2/i })).not.toHaveTextContent("penalty");
  });

  it("does not post a run when extra request body is invalid", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [] });
      }
      return jsonResponse(baseRun({ events: [] } as Partial<RunFixture>));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "configured-model");
    fireEvent.change(screen.getByLabelText("Extra request body"), { target: { value: "[]" } });
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));

    await screen.findByText("Extra request body must be a JSON object.");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("clears a stale error when switching to a run", async () => {
    const existingRun = baseRun({
      id: "existing-run",
      status: "completed",
      model: "existing-model",
      completed: 2,
      passed: 2,
      liveScore: 1,
      finalScore: 1
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [existingRun] });
      return jsonResponse({ ...existingRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "configured-model");
    fireEvent.change(screen.getByLabelText("Extra request body"), { target: { value: "[]" } });
    await userEvent.click(screen.getByRole("button", { name: /start run/i }));
    await screen.findByText("Extra request body must be a JSON object.");

    await userEvent.click(await screen.findByRole("button", { name: /^existing-model/i }));

    await waitFor(() => {
      expect(screen.queryByText("Extra request body must be a JSON object.")).not.toBeInTheDocument();
    });
  });

  it("keeps start disabled until a model is entered", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ runs: [] })));

    render(<App />);
    const startButton = screen.getByRole("button", { name: /start run/i });
    expect(startButton).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "demo-model");

    expect(startButton).toBeEnabled();
  });

  it("posts resume for an incomplete stopped run", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const stoppedRun = baseRun({
      status: "cancelled",
      total: 3,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 1,
      finalScore: null,
      finishedAt: "2026-06-16T00:00:10.000Z"
    });
    const resumedRun = baseRun({ ...stoppedRun, status: "running", finishedAt: null });
    const staleEvents = [
      {
        type: "task-started",
        at: "2026-06-16T00:00:01.000Z",
        data: {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 1,
          index: 0,
          entryPoint: "foo",
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1"
        }
      },
      {
        type: "token",
        at: "2026-06-16T00:00:02.000Z",
        data: {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          index: 0,
          channel: "output",
          text: "old stale output"
        }
      }
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, requestInit?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/runs/run-1/resume") && requestInit?.method === "POST") {
        return jsonResponse(resumedRun);
      }
      if (requestUrl.endsWith("/api/runs")) {
        return jsonResponse({ runs: [stoppedRun] });
      }
      return jsonResponse({ ...stoppedRun, events: staleEvents });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const resumeButton = await screen.findByRole("button", { name: /resume/i });
    await screen.findByText(/old stale output/i);
    await waitFor(() => expect(resumeButton).toBeEnabled());
    await userEvent.click(resumeButton);

    const resumeRequest = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/runs/run-1/resume"));
    expect(resumeRequest?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    expect(JSON.parse(String(resumeRequest?.[1]?.body))).toMatchObject({
      benchmark: "humaneval",
      providerId: "local-default",
      baseUrl: "http://localhost:8000/v1",
      model: "demo-model",
      maxOutputTokens: 2048,
      timeoutSeconds: 15,
      parallelTasks: 1,
      passCount: 1,
      sampleLimit: 0,
      startIndex: 0,
      testNumbers: "",
      extraBody: {}
    });
    await waitFor(() => expect(screen.queryByText(/old stale output/i)).not.toBeInTheDocument());
  });

  it("enables resume for a completed run whose only failures are modelErrors", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const completedWithModelErrors = baseRun({
      status: "completed",
      total: 2,
      completed: 2,
      passed: 1,
      failed: 1,
      finishedAt: "2026-06-16T00:00:10.000Z",
      results: [
        { taskId: "HumanEval/0", index: 0, passed: true, entryPoint: "foo", prompt: "def foo(): pass", test: "assert foo()", tests: [] },
        {
          taskId: "HumanEval/1",
          index: 1,
          passed: false,
          entryPoint: "bar",
          prompt: "def bar(): pass",
          test: "assert bar()",
          tests: [],
          modelError: "Model request failed: HTTP 400 No model loaded."
        }
      ]
    });
    const resumedRun = baseRun({ ...completedWithModelErrors, status: "running", finishedAt: null, failed: 0, completed: 1, results: [completedWithModelErrors.results[0]] });
    const fetchMock = vi.fn((input: RequestInfo | URL, requestInit?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/runs/run-1/resume") && requestInit?.method === "POST") {
        return jsonResponse(resumedRun);
      }
      if (requestUrl.endsWith("/api/runs")) {
        return jsonResponse({ runs: [completedWithModelErrors] });
      }
      return jsonResponse({ ...completedWithModelErrors, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const resumeButton = await screen.findByRole("button", { name: /resume/i });
    await waitFor(() => expect(resumeButton).toBeEnabled());
    await userEvent.click(resumeButton);

    const resumeRequest = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/runs/run-1/resume"));
    expect(JSON.parse(String(resumeRequest?.[1]?.body))).toMatchObject({
      benchmark: "humaneval",
      providerId: "local-default",
      baseUrl: "http://localhost:8000/v1",
      model: "demo-model",
      maxOutputTokens: 2048,
      timeoutSeconds: 15,
      parallelTasks: 1,
      passCount: 1,
      sampleLimit: 0,
      startIndex: 0,
      testNumbers: "",
      extraBody: {}
    });
  });

  it("only shows the remaining metric for runs that are in progress", async () => {
    const completedRun = baseRun({
      status: "completed",
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      startedAt: "2026-06-16T00:00:00.000Z",
      finishedAt: "2026-06-16T00:00:30.000Z"
    });
    const runningRun = baseRun({
      id: "run-2",
      status: "running",
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [completedRun, runningRun] });
      }
      if (url.endsWith("/api/runs/run-2")) {
        return jsonResponse({ ...runningRun, events: [] });
      }
      return jsonResponse({ ...completedRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("button", { name: /completed.*demo-model|demo-model.*completed/i });
    expect(screen.queryByText("Remaining")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /running.*demo-model|demo-model.*running/i }));

    await waitFor(() => expect(screen.getByText("Remaining")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /disable finish notification/i })).toBeInTheDocument();
  });

  it("shows elapsed time and repetition penalty for a running task", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const runningRun = baseRun({
      status: "running",
      currentTaskId: "bbeh_mini/1",
      activeTaskIds: ["bbeh_mini/1"],
      benchmark: "bbeh-mini",
      config: { adaptiveRepetitionPenalty: true }
    } as Partial<RunFixture>);
    const events = [{
      type: "task-started",
      at: new Date(Date.now() - 4 * 60 * 1_000).toISOString(),
      data: {
        taskId: "bbeh_mini/1",
        attemptId: "bbeh_mini/1::pass-1",
        passNumber: 1,
        passTotal: 1,
        index: 1,
        subtask: "mini",
        repetitionPenalty: 1.1
      }
    }];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [runningRun] });
      return jsonResponse({ ...runningRun, events });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const taskRow = await screen.findByRole("button", { name: /bbeh_mini\/1/i });
    expect(taskRow).toHaveTextContent(/4m [01]s · penalty 1\.1 · in progress/);
  });

  it("restores running task elapsed time when its start event is no longer replayable", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const taskIdentifier = "HumanEval/4";
    const runningRun = baseRun({
      status: "running",
      currentTaskId: taskIdentifier,
      activeTaskIds: [taskIdentifier],
      activeTaskStartedAt: {
        [taskIdentifier]: new Date(Date.now() - 4 * 60 * 1_000).toISOString()
      }
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) return jsonResponse({ runs: [runningRun] });
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const taskRow = await screen.findByRole("button", { name: /HumanEval\/4/i });
    expect(taskRow).toHaveTextContent(/4m [01]s · in progress/);
  });

  it("keeps full live output and running task prompts after many tokens", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const runningRun = baseRun({
      status: "running",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"],
      config: {
        systemPrompt: "SYSTEM PROMPT",
        promptTemplate: "USER PROMPT\n%problem_code%"
      }
    } as Partial<RunFixture>);
    const taskPrompt = "def foo(x):\n    \"\"\"Return x.\"\"\"\n";
    const events = [
      {
        type: "task-started",
        at: "2026-06-16T00:00:01.000Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          entryPoint: "foo",
          prompt: taskPrompt,
          test: "assert foo(1) == 1"
        }
      },
      {
        type: "prompt",
        at: "2026-06-16T00:00:01.100Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: `USER PROMPT\n${taskPrompt}` }
          ]
        }
      },
      ...Array.from({ length: 6001 }, (_, index) => ({
        type: "token",
        at: "2026-06-16T00:00:02.000Z",
        data: {
          taskId: "HumanEval/0",
          index: 0,
          channel: "thinking",
          text: `token-${index} `
        }
      }))
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("Live output");
    await waitFor(() => expect(container.textContent).toContain("token-6000"));
    expect(container.textContent).toContain("token-0");
    expect(container.textContent).toContain("SYSTEM:\nSYSTEM PROMPT");
    expect(container.textContent).toContain(`USER PROMPT\n${taskPrompt}`);
    expect(container.textContent).toContain(taskPrompt);
    expect(container.textContent).not.toContain("Prompt pending.");
    expect(container.textContent).not.toContain("Task prompt pending.");
  });

  it("merges equal adjacent passes in the variability chart without merging distinct task outputs", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const multiPassRun = baseRun({
      status: "completed",
      total: 4,
      completed: 4,
      passed: 3,
      failed: 1,
      liveScore: 0.75,
      finalScore: 0.75,
      config: { passCount: 4 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "pass one",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(2) == 2", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(2) == 2",
          rawOutput: "pass two",
          extractedCode: "def foo(x): return x",
          generationMs: 1100
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-3",
          passNumber: 3,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: false,
          tests: [{ source: "assert foo(3) == 3", passed: false, actual: "1", expected: "3", operator: "==" }],
          prompt: "def foo(x): pass",
          test: "assert foo(3) == 3",
          rawOutput: "pass three",
          extractedCode: "def foo(x): return 1",
          generationMs: 1200
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-4",
          passNumber: 4,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(4) == 4", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(4) == 4",
          rawOutput: "pass four",
          extractedCode: "def foo(x): return x",
          generationMs: 900
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [multiPassRun] });
      }
      return jsonResponse({ ...multiPassRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("HumanEval/0");
    const variabilityRegion = screen.getByRole("region", { name: /pass variability/i });
    expect(within(variabilityRegion).getByText("Pass variability")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("100% swing")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 1 - 2")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 3")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 4")).toBeInTheDocument();
    expect(screen.getAllByText("1/1").length).toBeGreaterThan(0);
    expect(within(variabilityRegion).getByText("avg pass 1.1s")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("avg pass 1.2s")).toBeInTheDocument();
    expect(container.textContent).toMatch(/Mixed\s*1/);
    expect(screen.getAllByText("HumanEval/0")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 2/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 3/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 4/i })).toBeInTheDocument();
    expect(container.textContent).toContain("assert foo(1) == 1");

    await userEvent.click(screen.getByRole("tab", { name: /pass 3/i }));

    await waitFor(() => expect(container.textContent).toContain("assert foo(3) == 3"));
    expect(container.textContent).toContain("expected: 3");
  });

  it("merges sequential pending passes in the variability chart", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const pendingRun = baseRun({
      status: "running",
      total: 4,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.25,
      currentTaskId: "HumanEval/0",
      config: { passCount: 4 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 4,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "pass one",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        }
      ],
      events: [
        {
          type: "task-started",
          at: "2026-06-16T00:00:01.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, passTotal: 4, index: 0, entryPoint: "foo" }
        },
        {
          type: "task-started",
          at: "2026-06-16T00:00:02.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-3", passNumber: 3, passTotal: 4, index: 0, entryPoint: "foo" }
        },
        {
          type: "task-started",
          at: "2026-06-16T00:00:03.000Z",
          data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-4", passNumber: 4, passTotal: 4, index: 0, entryPoint: "foo" }
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [pendingRun] });
      }
      return jsonResponse(pendingRun);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/0");
    const variabilityRegion = screen.getByRole("region", { name: /pass variability/i });
    const passSpreadMetric = within(variabilityRegion).getByText("Pass spread").closest("div") as HTMLElement;
    const completedPassesMetric = within(variabilityRegion).getByText("Completed passes").closest("div") as HTMLElement;
    expect(within(passSpreadMetric).getByText("100%")).toBeInTheDocument();
    expect(within(passSpreadMetric).queryByText("100%-100%")).not.toBeInTheDocument();
    expect(within(completedPassesMetric).getByText("1/4")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 1")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("Pass 2 - 4")).toBeInTheDocument();
    expect(within(variabilityRegion).getByText("avg pass 1.0s")).toBeInTheDocument();
  });

  it("shows the possible score range when hovering the current in-progress pass percentage", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const inProgressRun = baseRun({
      status: "running",
      total: 8,
      completed: 3,
      passed: 2,
      failed: 1,
      liveScore: 2 / 3,
      currentTaskId: "HumanEval/3",
      activeTaskIds: ["HumanEval/3"],
      config: { passCount: 2 },
      results: Array.from({ length: 3 }, (_, index) => ({
        taskId: `HumanEval/${index}`,
        attemptId: `HumanEval/${index}::pass-1`,
        passNumber: 1,
        passTotal: 2,
        index,
        entryPoint: "foo",
        passed: index < 2,
        tests: [],
        prompt: "def foo(): pass",
        test: "assert foo()",
        rawOutput: "output",
        extractedCode: "def foo(): return 1",
        generationMs: 1000
      })),
      events: [{
        type: "task-started",
        at: "2026-06-16T00:00:03.000Z",
        data: {
          taskId: "HumanEval/3",
          attemptId: "HumanEval/3::pass-1",
          passNumber: 1,
          passTotal: 2,
          index: 3,
          entryPoint: "foo"
        }
      }]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [inProgressRun] });
      }
      return jsonResponse(inProgressRun);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/0");
    const variabilityRegion = screen.getByRole("region", { name: /pass variability/i });
    expect(within(variabilityRegion).getByText("66.7%"))
      .toHaveAttribute("title", "Possible range: 50%-75%");
  });

  it("merges task tabs when timing is the only difference and shows a time range", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const groupedTaskRun = baseRun({
      status: "completed",
      total: 2,
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      config: { passCount: 2 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        },
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1200
        }
      ]
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [groupedTaskRun] });
      }
      return jsonResponse({ ...groupedTaskRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<App />);

    await screen.findByText("HumanEval/0");
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1 - 2/i })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(container.textContent).toContain("1.0s - 1.2s");
  });

  it("merges a completed pass into an existing identical group after live output was present", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const runningRun = baseRun({
      status: "running",
      total: 2,
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"],
      config: { passCount: 2 },
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1000
        }
      ]
    } as Partial<RunFixture>);
    const completedRun = {
      ...runningRun,
      status: "completed",
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      finishedAt: "2026-06-16T00:00:03.000Z",
      currentTaskId: null,
      activeTaskIds: [],
      results: [
        ...runningRun.results,
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-2",
          passNumber: 2,
          passTotal: 2,
          index: 0,
          entryPoint: "foo",
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "same output",
          extractedCode: "def foo(x): return x",
          generationMs: 1200
        }
      ]
    };
    let detailFetches = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/providers")) {
        return jsonResponse({ providers: [{ id: "local-default", name: "Local model server", baseUrl: "http://localhost:8000/v1", hasApiKey: false }] });
      }
      if (url.endsWith("/api/benchmarks")) {
        return jsonResponse({ benchmarks: [] });
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      detailFetches += 1;
      if (detailFetches === 1) {
        return jsonResponse({
          ...runningRun,
          events: [
            {
              type: "task-started",
              at: "2026-06-16T00:00:01.000Z",
              data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, passTotal: 2, index: 0, entryPoint: "foo" }
            },
            {
              type: "token",
              at: "2026-06-16T00:00:02.000Z",
              data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, index: 0, channel: "output", text: "temporary live output" }
            }
          ]
        });
      }
      return jsonResponse({ ...completedRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/0");
    expect(screen.getByRole("tab", { name: /pass 1/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /pass 2/i })).toBeInTheDocument();

    FakeEventSource.instances[0].emit("task-finished", {
      type: "task-finished",
      at: "2026-06-16T00:00:03.000Z",
      data: { summary: completedRun }
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /HumanEval\/0/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /HumanEval\/0/i }));
    expect(screen.getByRole("tab", { name: /pass 1 - 2/i })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("shows elapsed and expected total duration while running", async () => {
    const startedAt = new Date(Date.now() - 25_000).toISOString();
    const runningRun = baseRun({
      status: "running",
      total: 4,
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 0.5,
      startedAt,
      currentTaskId: "HumanEval/2",
      activeTaskIds: ["HumanEval/2"],
      results: [
        {
          taskId: "HumanEval/0",
          index: 0,
          entryPoint: "task0",
          passed: true,
          tests: [],
          prompt: "",
          test: "",
          rawOutput: "",
          extractedCode: "",
          generationMs: 10_000,
          activeDurationMilliseconds: 12_000
        },
        {
          taskId: "HumanEval/1",
          index: 1,
          entryPoint: "task1",
          passed: true,
          tests: [],
          prompt: "",
          test: "",
          rawOutput: "",
          extractedCode: "",
          generationMs: 10_000,
          activeDurationMilliseconds: 12_000
        }
      ]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /running.*demo-model|demo-model.*running/i }));

    await screen.findByText("Speed");
    const speedMetric = screen.getByText("Speed").closest(".bench-metric") as HTMLElement;
    expect(within(speedMetric).getByText("Per task")).toBeInTheDocument();
    expect(within(speedMetric).getByText("12s")).toBeInTheDocument();
    expect(within(speedMetric).getByText("Run so far")).toBeInTheDocument();
    expect(within(speedMetric).getByText(/24s/)).toBeInTheDocument();
    expect(within(speedMetric).getByText("Expected total")).toBeInTheDocument();
    expect(within(speedMetric).getByText(/~48s/)).toBeInTheDocument();
  });

  it("does not notify for a run that was disabled from its remaining card", async () => {
    const notificationCalls = installNotificationMock();
    const runningRun = baseRun({
      status: "running",
      completed: 1,
      passed: 1,
      failed: 0,
      liveScore: 0.5,
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runningRun] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /running.*demo-model|demo-model.*running/i }));
    await userEvent.click(screen.getByRole("button", { name: /disable finish notification/i }));
    expect(screen.getByRole("button", { name: /enable finish notification/i })).toBeInTheDocument();

    FakeEventSource.instances[0].emit("done", {
      type: "done",
      at: "2026-06-16T00:00:03.000Z",
      data: {
        summary: {
          ...runningRun,
          status: "completed",
          completed: 2,
          passed: 2,
          liveScore: 1,
          finalScore: 1,
          finishedAt: "2026-06-16T00:00:03.000Z"
        }
      }
    });

    await waitFor(() => expect(FakeEventSource.instances[0].closed).toBe(true));
    expect(notificationCalls).toHaveLength(0);
  });

  it("swaps start and resume for add-to-queue buttons while a run is live", async () => {
    window.history.replaceState(null, "", "/run/run-stopped");
    const runningRun = baseRun({
      id: "run-live",
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"]
    });
    const stoppedRun = baseRun({
      id: "run-stopped",
      status: "cancelled",
      total: 3,
      completed: 1,
      passed: 1,
      finishedAt: "2026-06-16T00:00:10.000Z"
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [runningRun, stoppedRun] });
      }
      if (url.endsWith("/api/runs/run-live")) {
        return jsonResponse({ ...runningRun, events: [] });
      }
      return jsonResponse({ ...stoppedRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("button", { name: /add to queue/i })).toBeInTheDocument();
    const queueResumeButton = screen.getByRole("button", { name: /queue resume/i });
    await waitFor(() => expect(queueResumeButton).toBeEnabled());
    expect(screen.queryByRole("button", { name: /start run/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
  });

  it("shows queue position badges and removes a queued run when its badge is clicked", async () => {
    const runningRun = baseRun({
      id: "run-live",
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"]
    });
    const queuedFirst = baseRun({
      id: "run-q1",
      status: "queued",
      model: "first-in-line",
      queuedAt: "2026-06-16T00:01:00.000Z",
      queuePosition: 1
    });
    const queuedSecond = baseRun({
      id: "run-q2",
      status: "queued",
      model: "second-in-line",
      queuedAt: "2026-06-16T00:02:00.000Z",
      queuePosition: 2
    });
    let removed = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs/run-q1/cancel") && init?.method === "POST") {
        removed = true;
        return jsonResponse({ ...queuedFirst, status: "cancelled", queuePosition: null });
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({
          runs: removed
            ? [runningRun, { ...queuedFirst, status: "cancelled", queuePosition: null }, { ...queuedSecond, queuePosition: 1 }]
            : [runningRun, queuedFirst, queuedSecond]
        });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const firstBadge = await screen.findByRole("button", {
      name: "Remove benchmark run first-in-line from queue (position 1)"
    });
    expect(firstBadge).toHaveTextContent("1");
    expect(screen.getByRole("button", {
      name: "Remove benchmark run second-in-line from queue (position 2)"
    })).toHaveTextContent("2");

    await userEvent.click(firstBadge);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/api/runs/run-q1/cancel", { method: "POST" });
    await screen.findByRole("button", {
      name: "Remove benchmark run second-in-line from queue (position 1)"
    });
    expect(screen.getAllByRole("button", { name: /remove benchmark run/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^first-in-line/ })).toHaveTextContent(/cancelled.*0\/2/);
  });

  it("renumbers queue badges when the queue advances", async () => {
    const runningRun = baseRun({
      id: "run-live",
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"]
    });
    const queuedFirst = baseRun({
      id: "run-q1",
      status: "queued",
      model: "first-in-line",
      queuedAt: "2026-06-16T00:01:00.000Z",
      queuePosition: 1
    });
    const queuedSecond = baseRun({
      id: "run-q2",
      status: "queued",
      model: "second-in-line",
      queuedAt: "2026-06-16T00:02:00.000Z",
      queuePosition: 2
    });
    let advanced = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({
          runs: advanced
            ? [
                { ...queuedFirst, status: "running", queuePosition: null },
                { ...runningRun, status: "completed", completed: 2, passed: 2, finishedAt: "2026-06-16T00:05:00.000Z" },
                { ...queuedSecond, queuePosition: 1 }
              ]
            : [runningRun, queuedFirst, queuedSecond]
        });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByRole("button", {
      name: "Remove benchmark run second-in-line from queue (position 2)"
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));

    // The server finished the active run and promoted the first queued run;
    // that run's run-started event is the signal that the queue advanced.
    advanced = true;
    FakeEventSource.instances[1].emit("run-started", {
      type: "run-started",
      at: "2026-06-16T00:05:00.000Z",
      data: { summary: { ...queuedFirst, status: "running", queuePosition: null } }
    });

    await screen.findByRole("button", {
      name: "Remove benchmark run second-in-line from queue (position 1)"
    });
    expect(screen.getAllByRole("button", { name: /remove benchmark run/i })).toHaveLength(1);
  });

  it("shows a run created while another is active as queued with its badge", async () => {
    const runningRun = baseRun({
      id: "run-live",
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"]
    });
    const queuedCreated = baseRun({
      id: "run-new",
      status: "queued",
      model: "queued-model",
      queuedAt: "2026-06-16T00:01:00.000Z",
      queuePosition: 1
    });
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        created = true;
        return jsonResponse(queuedCreated, 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: created ? [queuedCreated, runningRun] : [runningRun] });
      }
      if (url.endsWith("/api/runs/run-new")) {
        return jsonResponse({ ...queuedCreated, events: [] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const addToQueueButton = await screen.findByRole("button", { name: /add to queue/i });
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "queued-model");
    await userEvent.click(addToQueueButton);

    const badge = await screen.findByRole("button", {
      name: "Remove benchmark run queued-model from queue (position 1)"
    });
    expect(badge).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /^queued-model/ })).toHaveTextContent(/queued.*0\/2/);
    expect(window.location.pathname).toBe("/run/run-new");
    // The backend answered with queue fields, so no version warning appears.
    expect(screen.queryByText(/older version without run queueing/)).not.toBeInTheDocument();
  });

  it("warns when the benchmark server predates the run queue", async () => {
    const runningRun = baseRun({
      id: "run-live",
      status: "running",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/0",
      activeTaskIds: ["HumanEval/0"]
    });
    // An old server starts the run immediately and its summaries carry no
    // queuePosition/queuedAt keys at all.
    const startedImmediately = baseRun({ id: "run-new", status: "running", model: "skewed-model" });
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runs") && init?.method === "POST") {
        created = true;
        return jsonResponse(startedImmediately, 201);
      }
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: created ? [startedImmediately, runningRun] : [runningRun] });
      }
      if (url.endsWith("/api/runs/run-new")) {
        return jsonResponse({ ...startedImmediately, events: [] });
      }
      return jsonResponse({ ...runningRun, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const addToQueueButton = await screen.findByRole("button", { name: /add to queue/i });
    await userEvent.type(screen.getByPlaceholderText("provider/model-name"), "skewed-model");
    await userEvent.click(addToQueueButton);

    expect(await screen.findByText(/older version without run queueing/)).toBeInTheDocument();
    expect(screen.getByText(/Restart the benchmark server/)).toBeInTheDocument();
  });

  it("selects a run from a /run/:id deep link", async () => {
    window.history.replaceState(null, "", "/run/run-2");
    const run = baseRun({
      id: "run-2",
      status: "completed",
      model: "deep-link-model",
      completed: 2,
      passed: 1,
      failed: 1,
      liveScore: 0.5,
      finalScore: 0.5
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      if (url.endsWith("/api/runs/run-2")) {
        return jsonResponse({ ...run, events: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByPlaceholderText("provider/model-name")).toHaveValue("deep-link-model"));
    expect(screen.getAllByText("completed")).not.toHaveLength(0);
    expect(window.location.pathname).toBe("/run/run-2");
  });

  it("shows total and current pass completion in the completed metric", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const run = baseRun({
      status: "running",
      total: 4,
      completed: 3,
      passed: 2,
      failed: 1,
      liveScore: 2 / 3,
      config: { passCount: 2 }
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("Completed");
    const completedMetric = screen.getByText("Completed").closest(".bench-metric") as HTMLElement;
    expect(within(completedMetric).getByText("Total:")).toBeInTheDocument();
    expect(within(completedMetric).getByText("75% (3/4)")).toBeInTheDocument();
    expect(within(completedMetric).getByText("2nd pass:")).toBeInTheDocument();
    expect(within(completedMetric).getByText("50% (1/2)")).toBeInTheDocument();
  });

  it("separates assertion failures from harness errors and highlights the traceback", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const run = baseRun({
      status: "completed",
      total: 2,
      completed: 2,
      passed: 0,
      failed: 2,
      results: [
        {
          taskId: "HumanEval/0",
          index: 0,
          entryPoint: "foo",
          passed: false,
          tests: [{ source: "assert foo(1) == 1", passed: false }],
          prompt: "def foo(x): pass",
          test: "assert foo(1) == 1",
          rawOutput: "def foo(x): return 0",
          extractedCode: "def foo(x): return 0"
        },
        {
          taskId: "HumanEval/1",
          index: 1,
          entryPoint: "bar",
          passed: false,
          tests: [],
          prompt: "def bar(x): pass",
          test: "assert bar(1) == 1",
          rawOutput: "```python\ndef bar(x):",
          extractedCode: "```python\ndef bar(x):",
          error: "invalid syntax",
          traceback: "Traceback (most recent call last):\nSyntaxError: invalid syntax"
        }
      ]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByText("HumanEval/1");
    const failedMetric = screen.getByText("Failed").closest(".bench-metric") as HTMLElement;
    expect(within(failedMetric).getByText("Assertions")).toBeInTheDocument();
    expect(within(failedMetric).getByText("Errors")).toBeInTheDocument();
    expect(within(failedMetric).getAllByText("1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /fail.*HumanEval\/0/i })).toBeInTheDocument();
    const errorTask = screen.getByRole("button", { name: /error.*HumanEval\/1/i });

    await userEvent.click(errorTask);

    const traceback = screen.getByText(/SyntaxError: invalid syntax/);
    expect(traceback).toHaveClass("harness-error");
    expect(traceback.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("No assertions ran.")).toHaveClass("assert-error");
  });

  it("keeps browser back and forward in sync with selected bench", async () => {
    const run = baseRun({
      id: "run-1",
      status: "completed",
      model: "history-model",
      config: { model: "history-model", baseUrl: "http://history.example/v1" }
    } as Partial<RunFixture>);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      return jsonResponse({ ...run, events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const modelInput = await screen.findByPlaceholderText("provider/model-name");
    await userEvent.click(screen.getByRole("button", { name: /completed.*history-model|history-model.*completed/i }));
    await waitFor(() => expect(modelInput).toHaveValue("history-model"));
    expect(window.location.pathname).toBe("/run/run-1");

    window.history.back();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(modelInput).toHaveValue(""));
    expect(window.location.pathname).toBe("/new");

    window.history.forward();
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(modelInput).toHaveValue("history-model"));
    expect(window.location.pathname).toBe("/run/run-1");
  });

  it("collects performance metrics only when debug performance mode is enabled", async () => {
    window.history.replaceState(null, "", "/run/run-1?debug=performance");
    const run = baseRun({
      id: "run-1",
      status: "running",
      model: "metrics-model",
      startedAt: "2026-06-16T00:00:00.000Z",
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"]
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      if (url.endsWith("/api/runs/run-1")) {
        return jsonResponse({
          ...run,
          events: [
            {
              type: "task-started",
              at: "2026-06-16T00:00:01.000Z",
              data: {
                taskId: "HumanEval/1",
                index: 1,
                entryPoint: "candidate",
                prompt: "def candidate(): pass",
                test: "assert candidate() is None"
              }
            }
          ]
        });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(window.llmEvalPerformanceMetrics?.selectedRunFetches).toHaveLength(1));
    expect(window.llmEvalPerformanceMetrics?.selectedRunFetches[0]).toMatchObject({
      runId: "run-1",
      eventCount: 1,
      tokenEventCount: 0
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    FakeEventSource.instances[0].emit("token", {
      type: "token",
      at: "2026-06-16T00:00:02.000Z",
      data: {
        taskId: "HumanEval/1",
        index: 1,
        channel: "output",
        text: "hello"
      }
    });

    await waitFor(() => expect(window.llmEvalPerformanceMetrics?.eventSource.eventTypes.token?.count).toBe(1));
    expect(window.llmEvalPerformanceMetrics?.eventSource.tokenChannels.output.textBytes).toBeGreaterThan(0);
    expect(window.llmEvalPerformanceMetrics?.state?.runId).toBe("run-1");
  });

  it("does not expose performance metrics by default", async () => {
    window.history.replaceState(null, "", "/run/run-1");
    const run = baseRun({
      id: "run-1",
      status: "completed",
      model: "no-metrics-model",
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/runs")) {
        return jsonResponse({ runs: [run] });
      }
      if (url.endsWith("/api/runs/run-1")) {
        return jsonResponse({ ...run, events: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByPlaceholderText("provider/model-name")).toHaveValue("no-metrics-model"));
    expect(window.llmEvalPerformanceMetrics).toBeUndefined();
  });
});
