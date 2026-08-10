// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { writeRunArtifacts } from "./artifacts.mjs";
import {
  buildPromptMessages,
  compactResult,
  discardResumeArtifacts,
  extractCodeFromOutput,
  extractTextFromDelta,
  normalizeBaseUrl,
  normalizeParallelTasks,
  normalizePassCount,
  isLocalBaseUrl,
  normalizeTaskCount,
  parseTestNumbers,
  redactApiKey,
  renderPromptTemplate,
  runHasModelErrorResults,
  runtimeConfigFromPersistedRun,
  runSummary,
  syncRunCountsFromResults
} from "./domain.mjs";

let tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

function runFixture(overrides = {}) {
  return {
    id: "run-1",
    dir: null,
    status: "completed",
    model: "demo-model",
    baseUrl: "http://localhost:8000/v1",
    createdAt: "2026-06-16T00:00:00.000Z",
    startedAt: "2026-06-16T00:00:00.000Z",
    finishedAt: "2026-06-16T00:00:01.000Z",
    total: 1,
    completed: 1,
    passed: 1,
    failed: 0,
    currentTaskId: null,
    activeTaskIds: [],
    selectedIndices: [0],
    parallelTasks: 1,
    passCount: 1,
    publicConfig: { maxOutputTokens: 2048, testNumbers: "0" },
    results: [{
      taskId: "HumanEval/0",
      index: 0,
      entryPoint: "foo",
      passed: true,
      tests: [{ source: "assert foo(1) == 1", passed: true }],
      prompt: "def foo(x): pass",
      test: "assert foo(1) == 1",
      rawOutput: "```python\ndef foo(x): return x\n```",
      thinkingOutput: "private",
      extractedCode: "def foo(x): return x",
      generationMs: 100,
      evaluationDurationMilliseconds: 10,
      activeDurationMilliseconds: 110
    }],
    ...overrides
  };
}

describe("server domain helpers", () => {
  it("parses explicit test numbers, ranges, task ids, duplicates, and empty input", () => {
    expect(parseTestNumbers("", 10)).toEqual([]);
    expect(parseTestNumbers("0, 2 4-6 HumanEval/8 2", 10)).toEqual([0, 2, 4, 5, 6, 8]);
    expect(parseTestNumbers("5-3", 10)).toEqual([3, 4, 5]);
    expect(parseTestNumbers([3, "2", 3], 10)).toEqual([2, 3]);
    expect(() => parseTestNumbers("11", 10)).toThrow("Invalid test number");
  });

  it("normalizes base URLs and run bounds", () => {
    expect(normalizeBaseUrl(" http://localhost:8000/v1/ ")).toBe("http://localhost:8000/v1");
    expect(normalizeBaseUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(() => normalizeBaseUrl("")).toThrow("Base URL is required");
    expect(normalizeParallelTasks(99)).toBe(64);
    expect(normalizeParallelTasks(0)).toBe(1);
    expect(normalizePassCount(101)).toBe(100);
    expect(normalizePassCount(0)).toBe(1);
    expect(normalizeTaskCount(2.7)).toBe(2);
    expect(normalizeTaskCount(-5)).toBe(0);
    expect(normalizeTaskCount("abc")).toBe(0);
  });

  it("reports the offending tokens for unparseable test numbers", () => {
    expect(() => parseTestNumbers("bbeh_mini/3", 10, null)).toThrow("bbeh_mini/3");
    expect(() => parseTestNumbers("HumanEval/3", 10, null)).toThrow("HumanEval/3");
    expect(parseTestNumbers("3", 10, null)).toEqual([3]);
  });

  it("inserts task text literally even when it contains replacement patterns", () => {
    const problem = { prompt: "Costs are $100, so $& and $' must stay literal." };
    expect(renderPromptTemplate("Task: %problem%", problem)).toBe(`Task: ${problem.prompt}`);
    expect(renderPromptTemplate("Task: %problem_code%", problem)).toBe(`Task: ${problem.prompt}`);
  });

  it("builds prompt messages, extracts streamed deltas, and extracts code", () => {
    const problem = { prompt: "def foo(x):\n    pass" };

    expect(buildPromptMessages(problem, " system ", "Solve:\n%problem_code%")).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "Solve:\ndef foo(x):\n    pass" }
    ]);
    expect(extractTextFromDelta({ reasoning: "think", content: "code", refusal: "no" })).toEqual([
      { channel: "thinking", text: "think" },
      { channel: "output", text: "code" },
      { channel: "refusal", text: "no" }
    ]);
    expect(extractCodeFromOutput("```python\ndef foo(x):\n    return x\n```", problem.prompt)).toBe("def foo(x):\n    return x");
    expect(extractCodeFromOutput("```python\ndef foo(x):\n    return x", problem.prompt)).toBe("def foo(x):\n    return x");
    expect(extractCodeFromOutput("    return x", problem.prompt)).toBe(`${problem.prompt}return x`);
  });

  it("summarizes runs without leaking bulky result fields into compact events", () => {
    const run = runFixture({
      currentTaskId: "HumanEval/1",
      activeTaskIds: ["HumanEval/1"],
      activeTaskStartedAt: { "HumanEval/1": "2026-06-16T00:00:02.000Z" }
    });
    const summary = runSummary(run);
    const compact = compactResult(run.results[0]);

    expect(summary).toMatchObject({
      id: "run-1",
      liveScore: 1,
      finalScore: 1,
      assertionsPassed: 1,
      assertionsTotal: 1,
      assertionScore: 1,
      activeTaskStartedAt: { "HumanEval/1": "2026-06-16T00:00:02.000Z" },
      config: { baseUrl: "http://localhost:8000/v1", model: "demo-model", maxOutputTokens: 2048 }
    });
    expect(runSummary(run, { includeResults: false }).results).toEqual([]);
    expect(compact.rawOutput).toBeUndefined();
    expect(compact.extractedCode).toBeUndefined();
    expect(compact.tests).toHaveLength(1);
  });

  it("derives summary counts from results instead of cached run counts", () => {
    const run = runFixture({ completed: 463, passed: 315, failed: 148 });

    expect(runSummary(run)).toMatchObject({ completed: 1, passed: 1, failed: 0, liveScore: 1, finalScore: 1 });

    syncRunCountsFromResults(run);

    expect(run).toMatchObject({ completed: 1, passed: 1, failed: 0 });
  });

  it("redacts api keys for remote endpoints but keeps them for local ones", () => {
    expect(redactApiKey(" sk-live-secret ", "https://api.example.com/v1")).toBe("***");
    expect(redactApiKey("", "https://api.example.com/v1")).toBe("");
    expect(redactApiKey(undefined, "https://api.example.com/v1")).toBe("");
    expect(redactApiKey(" sk-live-secret ")).toBe("***");
    expect(redactApiKey(" sk-live-secret ", "http://localhost:8000/v1")).toBe("sk-live-secret");
    expect(redactApiKey(" sk-live-secret ", "http://127.0.0.1:8000/v1")).toBe("sk-live-secret");
    expect(redactApiKey(" sk-live-secret ", "http://[::1]:8000/v1")).toBe("sk-live-secret");
  });

  it("recognizes local base URLs", () => {
    expect(isLocalBaseUrl("http://localhost:8000/v1")).toBe(true);
    expect(isLocalBaseUrl("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isLocalBaseUrl("http://[::1]:8000/v1")).toBe(true);
    expect(isLocalBaseUrl("https://api.example.com/v1")).toBe(false);
    expect(isLocalBaseUrl("not a url")).toBe(false);
  });

  it("restores runtime config from persisted public run state", () => {
    const runtimeConfig = runtimeConfigFromPersistedRun({
      timeoutSeconds: undefined,
      maxOutputTokens: undefined,
      config: {
        apiKey: "***",
        temperature: 0.25,
        maxOutputTokens: 16384,
        thinkingEnabled: false,
        thinkingBudget: 4096,
        timeoutSeconds: 15,
        sampleLimit: 0,
        startIndex: 4,
        parallelTasks: 2,
        passCount: 100,
        systemPrompt: "system",
        promptTemplate: "prompt %problem_code%",
        extraBody: { top_p: 0.8 }
      }
    });

    expect(runtimeConfig).toMatchObject({
      apiKey: "",
      temperature: 0.25,
      maxOutputTokens: 16384,
      thinkingEnabled: false,
      thinkingBudget: 4096,
      timeoutSeconds: 15,
      sampleLimit: 0,
      startIndex: 4,
      parallelTasks: 2,
      passCount: 100,
      systemPrompt: "system",
      promptTemplate: "prompt %problem_code%",
      extraBody: { top_p: 0.8 },
      publicConfig: { apiKey: "***", timeoutSeconds: 15 }
    });
  });

  it("keeps a real api key for persisted local runs instead of redacting it", () => {
    const runtimeConfig = runtimeConfigFromPersistedRun({
      baseUrl: "http://localhost:8000/v1",
      config: {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "sk-live-secret"
      }
    });

    expect(runtimeConfig.apiKey).toBe("sk-live-secret");
    expect(runtimeConfig.publicConfig.apiKey).toBe("sk-live-secret");
  });

  it("discards model-error attempts before resuming a run", () => {
    const run = runFixture({
      total: 3,
      completed: 3,
      passed: 1,
      failed: 2,
      results: [
        {
          taskId: "HumanEval/0",
          attemptId: "HumanEval/0::pass-1",
          passNumber: 1,
          passed: true,
          tests: [{ source: "assert foo(1) == 1", passed: true }]
        },
        {
          taskId: "HumanEval/1",
          attemptId: "HumanEval/1::pass-1",
          passNumber: 1,
          passed: false,
          modelError: "Model request failed",
          tests: []
        },
        {
          taskId: "HumanEval/99",
          attemptId: "HumanEval/99::pass-1",
          passNumber: 1,
          passed: false,
          error: "Execution timed out",
          timeout: true,
          tests: []
        }
      ],
      events: [
        { type: "run-started", data: {} },
        { type: "error", data: { message: "Run cancelled.", summary: { status: "cancelled" } } },
        { type: "task-started", data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-1" } },
        { type: "token", data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-1" } },
        { type: "task-finished", data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-1" } },
        { type: "task-started", data: { taskId: "HumanEval/1", attemptId: "HumanEval/1::pass-1" } },
        { type: "task-started", data: { taskId: "HumanEval/99", attemptId: "HumanEval/99::pass-1" } }
      ]
    });

    discardResumeArtifacts(run);

    expect(run.results.map((result) => result.attemptId)).toEqual(["HumanEval/0::pass-1", "HumanEval/99::pass-1"]);
    expect(run).toMatchObject({ completed: 2, passed: 1, failed: 1 });
    expect(run.events.map((event) => event.type)).toEqual(["run-started", "task-started", "task-finished", "task-started"]);
    expect(run.events.some((event) => event.type === "error")).toBe(false);
    expect(run.events.some((event) => event.data.attemptId === "HumanEval/1::pass-1")).toBe(false);
  });

  it("detects a run with model-error results, even after a normal completion", () => {
    const cleanRun = runFixture({
      results: [{ taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-1", passed: true, tests: [] }]
    });
    const erroredRun = runFixture({
      results: [
        { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-1", passed: true, tests: [] },
        { taskId: "HumanEval/1", attemptId: "HumanEval/1::pass-1", passed: false, modelError: "Model request failed: HTTP 400 No model loaded.", tests: [] }
      ]
    });

    expect(runHasModelErrorResults(cleanRun)).toBe(false);
    expect(runHasModelErrorResults(erroredRun)).toBe(true);
  });

  it("writes run and result artifacts with public run state", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "eval-artifacts-"));
    tempDirs.push(dir);
    const run = runFixture({
      completed: 463,
      passed: 315,
      failed: 148,
      publicConfig: { apiKey: "***", maxOutputTokens: 2048, testNumbers: "0" }
    });

    await writeRunArtifacts(run, dir);

    const runJson = JSON.parse(await fs.readFile(join(run.dir, "run.json"), "utf8"));
    const resultsJson = JSON.parse(await fs.readFile(join(run.dir, "results.json"), "utf8"));
    expect(runJson).toMatchObject({
      id: "run-1",
      completed: 1,
      passed: 1,
      failed: 0,
      results: [],
      config: { apiKey: "***", testNumbers: "0" }
    });
    expect(resultsJson).toHaveLength(1);
    expect(resultsJson[0].rawOutput).toContain("```python");
  });
});
