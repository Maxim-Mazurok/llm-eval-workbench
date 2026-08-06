// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivedRunState, migrateSavedResults } from "./update-saved-results.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("saved result migration", () => {
  it("backs up and atomically updates results, summaries, and logs", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-migration-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "run-directory");
    const backupDir = join(runsDir, "backups");
    await fs.mkdir(runDir);
    const oldRun = {
      id: "run-1",
      model: "demo",
      status: "completed",
      total: 1,
      completed: 1,
      passed: 0,
      failed: 1,
      liveScore: 0,
      finalScore: 0,
      assertionsPassed: 0,
      assertionsTotal: 0,
      assertionScore: 0,
      config: { timeoutSeconds: 9 }
    };
    const oldResult = {
      taskId: "HumanEval/94",
      attemptId: "HumanEval/94::pass-1",
      passNumber: 1,
      index: 94,
      entryPoint: "answer",
      passed: false,
      tests: [],
      prompt: "def answer(x):\n    pass\n",
      test: "def check(candidate):\n    assert candidate(1) == 1",
      rawOutput: "```python\ndef answer(x):\n    return x",
      extractedCode: "def answer(x):\n    pass\n```python\ndef answer(x):\n    return x",
      error: "invalid syntax",
      traceback: "SyntaxError"
    };
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify(oldRun));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([oldResult]));
    await fs.writeFile(join(runDir, "task-logs.jsonl"), [
      JSON.stringify({ taskId: oldResult.taskId, attemptId: oldResult.attemptId, passNumber: 1, passed: false, channel: "extracted-code", text: oldResult.extractedCode }),
      JSON.stringify({ taskId: oldResult.taskId, attemptId: oldResult.attemptId, passNumber: 1, passed: false, channel: "harness", text: "SyntaxError" })
    ].join("\n") + "\n");
    const executeTestsFn = vi.fn(async () => ({
      passed: true,
      tests: [{ source: "assert candidate(1) == 1", passed: true }],
      stdout: "",
      stderr: "",
      harnessStdout: "json",
      harnessStderr: "",
      error: null,
      traceback: null,
      timeout: false
    }));

    const report = await migrateSavedResults({
      runsDir,
      backupDir,
      apply: true,
      executeTestsFn,
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });

    expect(report.totals).toMatchObject({ changedRuns: 1, changedResults: 1, oldPassed: 0, newPassed: 1 });
    expect(executeTestsFn).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "HumanEval/94", entry_point: "answer" }),
      "def answer(x):\n    return x",
      9
    );
    const results = JSON.parse(await fs.readFile(join(runDir, "results.json"), "utf8"));
    expect(results[0]).toMatchObject({ passed: true, extractedCode: "def answer(x):\n    return x", error: null, tests: [{ passed: true }] });
    const run = JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8"));
    expect(run).toMatchObject({ completed: 1, passed: 1, failed: 0, liveScore: 1, finalScore: 1, assertionsPassed: 1, assertionsTotal: 1 });
    const taskLogs = (await fs.readFile(join(runDir, "task-logs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    expect(taskLogs).toEqual([{ taskId: oldResult.taskId, attemptId: oldResult.attemptId, passNumber: 1, passed: true, channel: "extracted-code", text: "def answer(x):\n    return x" }]);
    expect(JSON.parse(await fs.readFile(join(backupDir, "run-directory", "results.json"), "utf8"))).toEqual([oldResult]);

    const secondPass = await migrateSavedResults({ runsDir, apply: false, executeTestsFn });
    expect(secondPass.totals.changedResults).toBe(0);
    expect(executeTestsFn).toHaveBeenCalledOnce();
  });

  it("preserves explicit model errors with empty output", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-migration-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "run-directory");
    await fs.mkdir(runDir);
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify({ id: "run-2", model: "demo", total: 1 }));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([{
      taskId: "HumanEval/1",
      entryPoint: "foo",
      passed: false,
      tests: [],
      prompt: "def foo(): pass",
      test: "def check(candidate): pass",
      rawOutput: "",
      extractedCode: "",
      modelError: "request aborted"
    }]));
    const executeTestsFn = vi.fn();

    const report = await migrateSavedResults({ runsDir, apply: true, executeTestsFn });

    expect(report.totals.changedResults).toBe(0);
    expect(executeTestsFn).not.toHaveBeenCalled();
  });

  it("re-evaluates changed BBEH answers with the benchmark parser", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "bbeh-migration-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "run-directory");
    await fs.mkdir(runDir);
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify({
      id: "bbeh-run",
      benchmark: "bbeh-mini",
      model: "demo",
      total: 1,
      passed: 0,
      config: { benchmark: "bbeh-mini" }
    }));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([{
      taskId: "bbeh_mini/22",
      attemptId: "bbeh_mini/22::pass-1",
      passNumber: 1,
      passed: false,
      tests: [{ passed: false }],
      prompt: "Question?",
      rawOutput: "The answer is: <no,unknown,yes>",
      extractedCode: "<no,unknown,yes>",
      expectedAnswer: "no, unknown, yes"
    }]));
    const executeTestsFn = vi.fn();

    const report = await migrateSavedResults({ runsDir, apply: true, executeTestsFn });

    expect(report.totals).toMatchObject({ changedRuns: 1, changedResults: 1, oldPassed: 0, newPassed: 1 });
    expect(executeTestsFn).not.toHaveBeenCalled();
    const results = JSON.parse(await fs.readFile(join(runDir, "results.json"), "utf8"));
    expect(results[0]).toMatchObject({
      passed: true,
      extractedCode: "no,unknown,yes",
      prediction: "no,unknown,yes",
      tests: [{ passed: true, actual: "no,unknown,yes", expected: "no,unknown,yes" }]
    });
  });

  it("derives cached run and assertion counts from migrated results", () => {
    expect(derivedRunState({ total: 3 }, [
      { passed: true, tests: [{ passed: true }, { passed: true }] },
      { passed: false, tests: [{ passed: false }] }
    ])).toMatchObject({
      completed: 2,
      passed: 1,
      failed: 1,
      liveScore: 0.5,
      finalScore: 1 / 3,
      assertionsPassed: 2,
      assertionsTotal: 3,
      assertionScore: 2 / 3
    });
  });
});
