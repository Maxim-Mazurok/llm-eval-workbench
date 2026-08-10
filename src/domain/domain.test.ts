import { describe, expect, it } from "vitest";
import {
  benchmarkApiOrigin,
  type BenchResult,
  type BenchRun,
  type EventEnvelope,
  type TokenEvent
} from "./benchmark";
import {
  analyzeThinkingComments,
  commentSignalIsFlagged,
  formatCommentSignal,
  generatedTail,
  thinkingInCommentsStats
} from "./comments";
import {
  groupSequentialChartPasses,
  groupSequentialPasses,
  passPossibleScoreRange,
  passRangeLabel,
  passVariabilityStats
} from "./passes";
import { currentPassTiming } from "./passTiming";
import { buildInstructionPromptFallback, formatPromptMessages } from "./prompts";
import {
  anyRunLive,
  assertionStats,
  completedMetricLines,
  failureStats,
  liveEstimate,
  progressSegments,
  resultNumbers,
  resultStatus,
  runQueueBadgePosition,
  runTotal,
  scoreRange,
  speedStats
} from "./runs";
import {
  orderedChannelOutput,
  promptInfoByAttempt,
  taskGroupsFromRun,
  tokensByAttempt
} from "./tasks";

const result = (overrides: Partial<BenchResult>): BenchResult => ({
  taskId: "HumanEval/0",
  attemptId: "HumanEval/0::pass-1",
  passNumber: 1,
  passTotal: 1,
  index: 0,
  entryPoint: "foo",
  passed: true,
  tests: [],
  prompt: "def foo(x):\n    pass",
  test: "assert foo(1) == 1",
  rawOutput: "",
  extractedCode: "def foo(x):\n    return x",
  ...overrides
});

const run = (overrides: Partial<BenchRun>): BenchRun => ({
  id: "run-1",
  status: "completed",
  model: "demo-model",
  baseUrl: "http://localhost:8000/v1",
  createdAt: "2026-06-16T00:00:00.000Z",
  startedAt: "2026-06-16T00:00:00.000Z",
  finishedAt: "2026-06-16T00:00:20.000Z",
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
  results: [],
  ...overrides
});

describe("benchmark API origin", () => {
  it("uses the frontend hostname with the benchmark server port", () => {
    expect(benchmarkApiOrigin("http://192.168.0.235:5173/run/example")).toBe(
      "http://192.168.0.235:8787"
    );
  });
});

describe("run domain helpers", () => {
  it("reports a live queue and badge positions only for queued runs", () => {
    expect(anyRunLive([])).toBe(false);
    expect(anyRunLive([run({ status: "completed" }), run({ status: "cancelled" })])).toBe(false);
    expect(anyRunLive([run({ status: "completed" }), run({ status: "running" })])).toBe(true);
    expect(anyRunLive([run({ status: "queued" })])).toBe(true);

    expect(runQueueBadgePosition(run({ status: "queued", queuePosition: 2 }))).toBe(2);
    // A queued run already picked to start next has no position to show.
    expect(runQueueBadgePosition(run({ status: "queued", queuePosition: null }))).toBeNull();
    expect(runQueueBadgePosition(run({ status: "queued" }))).toBeNull();
    // Stale positions on non-queued statuses never render a badge.
    expect(runQueueBadgePosition(run({ status: "running", queuePosition: 1 }))).toBeNull();
  });

  it("computes totals, score ranges, progress, assertions, and result numbers", () => {
    const sample = run({
      total: 4,
      completed: 2,
      passed: 1,
      failed: 1,
      results: [
        result({ index: 2, passed: true, tests: [{ source: "assert a", passed: true }] }),
        result({ index: 0, passed: false, tests: [{ source: "assert b", passed: false }] })
      ]
    });

    expect(runTotal(sample)).toBe(4);
    expect(scoreRange(sample)).toEqual({ worst: 0.25, best: 0.75 });
    expect(progressSegments(sample)).toEqual({ failed: 25, passed: 25, remaining: 50 });
    expect(assertionStats(sample.results)).toEqual({ passed: 1, total: 2, score: 0.5 });
    expect(resultNumbers(sample, "pass")).toBe("2");
    expect(resultNumbers(sample, "fail")).toBe("0");
  });

  it("marks graded fractional scores as partial and uses scores in ranges", () => {
    const partial = result({
      index: 3,
      passed: false,
      score: 0.7,
      tests: [{ source: "value within tolerance", passed: true }, { source: "range covers", passed: false }]
    });
    const zeroScore = result({ index: 5, passed: false, score: 0, tests: [{ source: "value within tolerance", passed: false }] });
    expect(resultStatus(partial)).toBe("partial");
    expect(resultStatus(zeroScore)).toBe("fail");
    // Status keys on answer quality: a wrong answer whose composite score is
    // non-zero only through honest low confidence stays a fail, not partial.
    const honestWrong = result({
      index: 7,
      passed: false,
      score: 0.299,
      answerScore: 0,
      tests: [{ source: "category matches", passed: false }]
    });
    expect(resultStatus(honestWrong)).toBe("fail");
    const partialAnswer = result({
      index: 8,
      passed: false,
      score: 0.52,
      answerScore: 0.5,
      tests: [{ source: "value within tolerance", passed: false }]
    });
    expect(resultStatus(partialAnswer)).toBe("partial");
    expect(failureStats([partial, zeroScore])).toEqual({ failedAssertions: 1, partial: 1, errors: 0, looping: 0 });
    expect(resultNumbers(run({ results: [partial, zeroScore] }), "partial")).toBe("3");

    // Graded runs estimate the final range from earned score, not pass counts.
    const gradedRun = run({ total: 4, completed: 2, passed: 0, failed: 2, meanScore: 0.5, results: [] });
    expect(scoreRange(gradedRun)).toEqual({ worst: 0.25, best: 0.75 });
  });

  it("separates assertion failures from attempts that never ran an assertion", () => {
    const assertionFailure = result({ index: 4, passed: false, tests: [{ source: "assert a", passed: false }] });
    const harnessError = result({ index: 9, passed: false, tests: [], traceback: "SyntaxError" });
    const looping = result({ index: 12, passed: false, tests: [], looping: true });
    const passingLoop = result({ index: 13, passed: true, tests: [{ source: "answer matches", passed: true }], looping: true });
    const sample = run({ results: [assertionFailure, harnessError, looping] });

    expect(resultStatus(assertionFailure)).toBe("fail");
    expect(resultStatus(harnessError)).toBe("error");
    expect(resultStatus(looping)).toBe("loop");
    expect(resultStatus(passingLoop)).toBe("pass");
    expect(failureStats([passingLoop])).toEqual({ failedAssertions: 0, partial: 0, errors: 0, looping: 0 });
    expect(failureStats(sample.results)).toEqual({ failedAssertions: 1, partial: 0, errors: 1, looping: 1 });
    expect(resultNumbers(sample, "fail")).toBe("4");
    expect(resultNumbers(sample, "error")).toBe("9");
    expect(resultNumbers(sample, "loop")).toBe("12");
    expect(resultNumbers(run({ results: [passingLoop] }), "pass")).toBe("13");

    const repeatedPasses = run({
      results: [
        result({ index: 12, passed: false, looping: true }),
        result({ index: 12, passed: false, looping: true, passNumber: 2 })
      ]
    });
    expect(resultNumbers(repeatedPasses, "loop")).toBe("12");
  });

  it("formats completed pass, speed, and remaining metrics", () => {
    const nowMs = Date.parse("2026-06-16T00:00:30.000Z");
    const running = run({
      status: "running",
      total: 4,
      completed: 2,
      passed: 2,
      failed: 0,
      finishedAt: null,
      currentTaskId: "HumanEval/2",
      activeTaskIds: ["HumanEval/2"],
      config: { passCount: 2, parallelTasks: 1 },
      results: [
        result({ generationMs: 10_000, activeDurationMilliseconds: 12_000 }),
        result({ taskId: "HumanEval/1", generationMs: 20_000, activeDurationMilliseconds: 22_000 })
      ]
    });
    const events: EventEnvelope[] = [{
      type: "task-started",
      at: "2026-06-16T00:00:25.000Z",
      data: { taskId: "HumanEval/2" }
    }];

    expect(completedMetricLines(running)).toEqual([
      ["Total:", "50% (2/4)"],
      ["2nd pass:", "0% (0/2)"]
    ]);
    expect(liveEstimate(running, events, nowMs)?.remaining).toBe("29s");
    expect(liveEstimate(running, events, nowMs)?.expectedTotal).toBe("1m 8s");
    expect(currentPassTiming(running, events, nowMs)).toMatchObject({
      passNumber: 2,
      elapsed: "5.0s",
      remaining: "5s"
    });
    expect(speedStats(running, events, nowMs)).toEqual({ averageTask: "17s", elapsed: "39s" });

    const pausedCompletedRun = run({
      status: "completed",
      startedAt: "2026-06-16T00:00:00.000Z",
      finishedAt: "2026-06-18T00:00:00.000Z",
      completed: 2,
      total: 2,
      results: running.results
    });
    expect(speedStats(pausedCompletedRun, [], nowMs)).toEqual({ averageTask: "17s", elapsed: "34s" });

    const nearlyCompletedParallelRun = run({
      status: "running",
      total: 3,
      completed: 2,
      currentTaskId: "HumanEval/2",
      activeTaskIds: ["HumanEval/2"],
      config: { parallelTasks: 4 },
      results: [result({ generationMs: 10_000 }), result({ taskId: "HumanEval/1", generationMs: 10_000 })]
    });
    expect(liveEstimate(nearlyCompletedParallelRun, events, nowMs)?.remaining).toBe("5s");
  });
});

describe("pass and task derivation", () => {
  it("summarizes pass variability and merges equal adjacent pass rows", () => {
    const sample = run({
      config: { passCount: 3 },
      results: [
        result({ passNumber: 1, passTotal: 3, passed: true }),
        result({ passNumber: 2, passTotal: 3, passed: true }),
        result({ passNumber: 3, passTotal: 3, passed: false })
      ]
    });
    const stats = passVariabilityStats(sample);

    expect(stats.passRows.map((row) => [row.passNumber, row.passed, row.completed])).toEqual([
      [1, 1, 1],
      [2, 1, 1],
      [3, 0, 1]
    ]);
    expect(stats.taskCounts).toEqual({ total: 1, allPass: 0, mixed: 1, allFail: 0 });
    expect(groupSequentialChartPasses(stats.passRows).map((group) => passRangeLabel(group.startPass, group.endPass, 3))).toEqual([
      "Pass 1 - 2",
      "Pass 3"
    ]);
  });

  it("excludes unfinished pass rows from pass spread scoring", () => {
    const sample = run({
      status: "running",
      total: 4,
      completed: 3,
      passed: 2,
      failed: 1,
      finishedAt: null,
      config: { passCount: 2 },
      results: [
        result({ taskId: "HumanEval/0", passNumber: 1, passTotal: 2, passed: true, generationMs: 1000, activeDurationMilliseconds: 1500 }),
        result({ taskId: "HumanEval/1", passNumber: 1, passTotal: 2, passed: true, generationMs: 2000 }),
        result({ taskId: "HumanEval/0", passNumber: 2, passTotal: 2, passed: false })
      ]
    });
    const stats = passVariabilityStats(sample);
    const chartGroups = groupSequentialChartPasses(stats.passRows);

    expect(stats.passRows.map((row) => [row.passNumber, row.passed, row.completed])).toEqual([
      [1, 2, 2],
      [2, 0, 1]
    ]);
    expect(stats.completedPassCount).toBe(1);
    expect(stats.spreadPassCount).toBe(1);
    expect(stats.minScore).toBe(1);
    expect(stats.maxScore).toBe(1);
    expect(passPossibleScoreRange(stats.passRows[1], stats.tasksPerPass)).toEqual({ worst: 0, best: 0.5 });
    expect(chartGroups[0].averagePassDurationMilliseconds).toBe(3500);
    expect(chartGroups[1].averagePassDurationMilliseconds).toBeNull();
  });

  it("derives task groups, prompt info, and token channel output", () => {
    const events: EventEnvelope[] = [
      {
        type: "task-started",
        at: "2026-06-16T00:00:01.000Z",
        data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, passTotal: 2, index: 0, entryPoint: "foo", prompt: "def foo(): pass" }
      },
      {
        type: "prompt",
        at: "2026-06-16T00:00:01.100Z",
        data: { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, messages: [{ role: "user", content: "solve" }] }
      }
    ];
    const tokens: TokenEvent[] = [
      { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, channel: "output", text: "code" },
      { taskId: "HumanEval/0", attemptId: "HumanEval/0::pass-2", passNumber: 2, channel: "thinking", text: "plan" }
    ];
    const groupedTokens = tokensByAttempt(tokens);
    const promptInfo = promptInfoByAttempt(events, run({ config: { passCount: 2 }, results: [result({ passTotal: 2 })] }));
    const groups = taskGroupsFromRun(events, run({ config: { passCount: 2 }, results: [result({ passTotal: 2 })] }), groupedTokens, promptInfo);

    expect(groups[0].attempts.map((attempt) => attempt.passNumber)).toEqual([1, 2]);
    expect(promptInfo.get("HumanEval/0::pass-2")?.instructionPrompt).toBe("USER:\nsolve");
    expect(orderedChannelOutput(groupedTokens.get("HumanEval/0::pass-2"))).toEqual([
      ["thinking", "plan"],
      ["output", "code"]
    ]);
  });

  it("marks a zero-assertion harness failure as an error", () => {
    const selectedRun = run({
      results: [result({ passed: false, tests: [], error: "Execution timed out" })]
    });

    const groups = taskGroupsFromRun([], selectedRun, new Map(), new Map());

    expect(groups[0].attempts[0].status).toBe("error");
  });

  it("groups adjacent identical pass views only", () => {
    const first = { ...result({ passNumber: 1 }), key: "a", status: "pass" as const };
    const second = { ...result({ passNumber: 2 }), key: "b", status: "pass" as const };
    const third = { ...result({ passNumber: 3, passed: false }), key: "c", status: "fail" as const };

    expect(groupSequentialPasses([
      { attempt: first, mergeKey: "same" },
      { attempt: second, mergeKey: "same" },
      { attempt: third, mergeKey: "other" }
    ]).map((group) => [group.startPass, group.endPass, group.status])).toEqual([
      [1, 2, "pass"],
      [3, 3, "fail"]
    ]);
  });
});

describe("prompt and comment analysis", () => {
  it("formats prompt messages and builds fallback instructions", () => {
    expect(formatPromptMessages([{ role: "system", content: "sys" }, { role: "user", content: "user" }])).toBe("SYSTEM:\nsys\n\nUSER:\nuser");
    expect(buildInstructionPromptFallback(run({ config: { systemPrompt: "sys", promptTemplate: "task: %problem_code%" } }), "def foo(): pass")).toBe("SYSTEM:\nsys\n\nUSER:\ntask: def foo(): pass");
  });

  it("ignores prompt docstrings and flags generated comment-heavy code", () => {
    const prompt = "def foo(x):\n    \"\"\"Return x.\"\"\"\n";
    const clean = result({ prompt, extractedCode: `${prompt}    return x` });
    const noisy = result({ prompt, extractedCode: `${prompt}    # think step one\n    # think step two\n    return x` });

    expect(generatedTail(clean.extractedCode, prompt, "foo")).toContain("return x");
    expect(commentSignalIsFlagged(analyzeThinkingComments(clean), 50)).toBe(false);
    expect(commentSignalIsFlagged(analyzeThinkingComments(noisy), 50)).toBe(true);
    expect(thinkingInCommentsStats([clean, noisy], 50)).toEqual({ flagged: 1, total: 2 });
    expect(formatCommentSignal(analyzeThinkingComments(noisy), 50)).toContain("FLAGGED");
  });
});
