// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverSavedRuns,
  executeHumanEvalCandidate,
  legacyExtractCode,
  markdownReport,
  reprocessArchive
} from "./reprocess-saved-results.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("saved result reprocessing", () => {
  it("discovers runs through directory symlinks", async () => {
    const rootDirectory = await fs.mkdtemp(join(tmpdir(), "linked-run-test-"));
    tempDirs.push(rootDirectory);
    const runsDirectory = join(rootDirectory, "benchmark-runs");
    const archiveDirectory = join(rootDirectory, "archive", "saved-run");
    await fs.mkdir(runsDirectory);
    await fs.mkdir(archiveDirectory, { recursive: true });
    await fs.writeFile(
      join(archiveDirectory, "run.json"),
      JSON.stringify({ id: "linked-run", benchmark: "humaneval" }),
    );
    await fs.writeFile(join(archiveDirectory, "results.json"), "[]");
    await fs.symlink(archiveDirectory, join(runsDirectory, "saved-run"), "dir");

    const savedRuns = await discoverSavedRuns(runsDirectory);

    expect(savedRuns).toHaveLength(1);
    expect(savedRuns[0].run.id).toBe("linked-run");
  });

  it("re-extracts only from final output and reruns changed candidates", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-reprocess-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "saved-run");
    await fs.mkdir(runDir);

    const prompt = "def answer(x):\n    pass\n";
    const thinkingOutput = "```python\ndef leaked_from_thinking(x):\n    return 0\n```";
    const rawOutput = "```python\ndef answer(x):\n    return x";
    const rawTranscript = `${thinkingOutput}\n${rawOutput}`;
    const contaminatedCode = legacyExtractCode(rawTranscript, prompt);
    const cleanCode = "def stable(x):\n    return x";
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify({
      id: "run-1",
      model: "demo-model",
      status: "completed",
      total: 2,
      config: { timeoutSeconds: 7 }
    }));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([
      {
        taskId: "HumanEval/1",
        index: 1,
        entryPoint: "answer",
        passed: false,
        tests: [],
        prompt,
        test: "def check(candidate):\n    assert candidate(1) == 1",
        thinkingOutput,
        rawOutput,
        rawTranscript,
        extractedCode: contaminatedCode
      },
      {
        taskId: "HumanEval/2",
        index: 2,
        entryPoint: "stable",
        passed: true,
        tests: [{ source: "assert stable(1) == 1", passed: true }],
        prompt: "def stable(x):\n    pass\n",
        test: "def check(candidate):\n    assert candidate(1) == 1",
        thinkingOutput: "private chain of thought",
        rawOutput: `\`\`\`python\n${cleanCode}\n\`\`\``,
        rawTranscript: `private chain of thought\n${cleanCode}`,
        extractedCode: cleanCode
      }
    ]));
    const executeCandidate = vi.fn(async (_problem, code, timeoutSeconds) => ({
      status: code === "def answer(x):\n    return x" ? "pass" : "fail",
      timeoutSeconds
    }));

    const report = await reprocessArchive({ runsDir, executeCandidate, concurrency: 2, execute: true });

    expect(report.totals).toMatchObject({
      runDirectories: 1,
      results: 2,
      eligible: 2,
      withThinking: 2,
      changedExtractions: 1,
      affectedRuns: 1,
      oldPassed: 1,
      newPassed: 2
    });
    expect(executeCandidate).toHaveBeenCalledOnce();
    expect(executeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "HumanEval/1", entry_point: "answer" }),
      "def answer(x):\n    return x",
      7
    );
    expect(report.runs[0].affected[0]).toMatchObject({
      oldStatus: "error",
      newStatus: "pass",
      hadThinking: true,
      causes: expect.arrayContaining(["legacy transcript extraction", "thinking text present in stored code"])
    });
    expect(report.runs[0].passes).toEqual([{
      passNumber: 1,
      total: 2,
      plannedTotal: 2,
      oldPassed: 1,
      newPassed: 2,
      changedExtractions: 1
    }]);
    const markdown = markdownReport(report);
    expect(markdown).toContain("Aggregate passes: 1 -> 2 (+1)");
    expect(markdown).not.toContain("leaked_from_thinking");
    expect(markdown).not.toContain("private chain of thought");
  });

  it("skips saved runs from non-HumanEval benchmarks", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-reprocess-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "bbeh-run");
    await fs.mkdir(runDir);
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify({
      id: "bbeh-1",
      benchmark: "bbeh-mini",
      model: "demo-model",
      status: "completed",
      config: { benchmark: "bbeh-mini" }
    }));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([
      {
        taskId: "bbeh_mini/0",
        index: 0,
        passed: true,
        tests: [{ source: "final answer matches target (official BBEH fuzzy match)", passed: true }],
        prompt: "Question?",
        rawOutput: "The answer is: yes.",
        extractedCode: "yes"
      }
    ]));
    const executeCandidate = vi.fn();

    const report = await reprocessArchive({ runsDir, executeCandidate, execute: true });

    expect(report.totals.runDirectories).toBe(0);
    expect(executeCandidate).not.toHaveBeenCalled();
  });

  it("can compare extractions without executing candidates", async () => {
    const runsDir = await fs.mkdtemp(join(tmpdir(), "humaneval-reprocess-test-"));
    tempDirs.push(runsDir);
    const runDir = join(runsDir, "saved-run");
    await fs.mkdir(runDir);
    await fs.writeFile(join(runDir, "run.json"), JSON.stringify({ id: "run-2", model: "demo", total: 1 }));
    await fs.writeFile(join(runDir, "results.json"), JSON.stringify([{
      taskId: "HumanEval/3",
      entryPoint: "foo",
      passed: false,
      tests: [],
      prompt: "def foo():\n    pass\n",
      test: "def check(candidate):\n    assert candidate() == 1",
      rawOutput: "```python\ndef foo():\n    return 1",
      extractedCode: "def foo():\n    pass\n```python\ndef foo():\n    return 1"
    }]));

    const report = await reprocessArchive({ runsDir, execute: false });

    expect(report.mode).toBe("extraction comparison only");
    expect(report.runs[0].affected[0].newStatus).toBe("not rerun");
  });

  it("classifies pass, assertion failure, and load error in the isolated harness", async () => {
    const problem = {
      entry_point: "candidate",
      test: "def check(candidate):\n    assert candidate(2) == 4"
    };

    await expect(executeHumanEvalCandidate(problem, "def candidate(x):\n    return x * 2", 2)).resolves.toMatchObject({ status: "pass" });
    await expect(executeHumanEvalCandidate(problem, "def candidate(x):\n    return x", 2)).resolves.toMatchObject({ status: "fail" });
    await expect(executeHumanEvalCandidate(problem, "```python\ndef candidate(x):", 2)).resolves.toMatchObject({ status: "error" });
  });
});
