// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  adjudicateFailureCases,
  aggregateBenchmarkFailures,
  analyzeArchive,
  markdownFailureReport,
  resultFailureKind
} from "./analyze-benchmark-failures.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function writeRun(root, name, run, results) {
  const directory = join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(join(directory, "run.json"), JSON.stringify(run)),
    fs.writeFile(join(directory, "results.json"), JSON.stringify(results))
  ]);
}

function result(taskId, passed, overrides = {}) {
  return {
    taskId,
    index: Number(taskId.split("/").at(-1)),
    passed,
    answerScore: passed ? 1 : 0,
    tests: [{ source: "answer matches", passed }],
    prompt: "private prompt",
    expectedAnswer: "private expected answer",
    rawOutput: "private model output",
    ...overrides
  };
}

describe("benchmark failure analysis", () => {
  it("separates semantic failures from model and transport failures", () => {
    expect(resultFailureKind(result("task/1", false))).toBe("semantic-failure");
    expect(resultFailureKind(result("task/1", false, { finishReason: "length" }))).toBe("truncated");
    expect(resultFailureKind(result("task/1", false, { looping: true }))).toBe("loop");
    expect(resultFailureKind(result("task/1", false, { modelError: "offline" }))).toBe("model-error");
    expect(resultFailureKind(result("task/1", true))).toBe("pass");
  });

  it("groups only within a benchmark data revision and collapses attempts by model", () => {
    const attempts = [
      { benchmark: "demo", revision: "rev-a", model: "small", runId: "a1", result: result("demo/1", false) },
      { benchmark: "demo", revision: "rev-a", model: "small", runId: "a2", result: result("demo/1", true) },
      { benchmark: "demo", revision: "rev-a", model: "large", runId: "a3", result: result("demo/1", false) },
      { benchmark: "demo", revision: "rev-b", model: "large", runId: "b1", result: result("demo/1", true) }
    ];
    const cases = aggregateBenchmarkFailures(attempts);

    expect(cases).toHaveLength(2);
    const revisionA = cases.find((entry) => entry.revision === "rev-a");
    expect(revisionA).toMatchObject({
      attempts: 3,
      models: 2,
      semanticModels: 2,
      failedModels: 1,
      unstableModels: 1,
      triage: "cross-model-split"
    });
    expect(revisionA.meanAnswerScore).toBe(0.25);
  });

  it("uses an opt-in judge without accepting unknown cases or labels", async () => {
    const attempts = [
      { benchmark: "demo", revision: "rev", model: "one", runId: "a", result: result("demo/4", false) },
      { benchmark: "demo", revision: "rev", model: "two", runId: "b", result: result("demo/4", false) }
    ];
    const cases = aggregateBenchmarkFailures(attempts, { includeContent: true });
    const fetchImpl = async (url, request) => {
      expect(url).toBe("http://localhost:8000/v1/chat/completions");
      const body = JSON.parse(request.body);
      expect(body.model).toBe("judge-model");
      expect(body.messages[1].content).toContain("private prompt");
      const caseId = JSON.parse(body.messages[1].content)[0].caseId;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({
            cases: [{ caseId, label: "benchmark_issue", confidence: 0.8, reason: "Insufficient context" }]
          })}\n\`\`\`` } }]
        })
      };
    };
    await expect(adjudicateFailureCases(cases, {
      model: "judge-model",
      baseUrl: "http://localhost:8000/v1/",
      fetchImpl
    })).resolves.toMatchObject([
      { label: "benchmark_issue", confidence: 0.8, reason: "Insufficient context" }
    ]);
  });

  it("keeps sensitive content out unless explicitly requested", () => {
    const attempts = [
      { benchmark: "demo", revision: "rev", model: "one", runId: "a", result: result("demo/2", false) },
      { benchmark: "demo", revision: "rev", model: "two", runId: "b", result: result("demo/2", false) }
    ];
    expect(aggregateBenchmarkFailures(attempts)[0]).not.toHaveProperty("content");
    expect(aggregateBenchmarkFailures(attempts, { includeContent: true })[0]).toMatchObject({
      content: {
        prompt: "private prompt",
        expectedAnswer: "private expected answer"
      }
    });
  });

  it("reads saved runs, filters them, and emits a compact review table", async () => {
    const runsDirectory = await fs.mkdtemp(join(tmpdir(), "failure-analysis-"));
    temporaryDirectories.push(runsDirectory);
    await writeRun(runsDirectory, "run-a", {
      id: "run-a",
      benchmark: "demo",
      benchmarkDataRevision: "rev",
      model: "model-a"
    }, [result("demo/3", false)]);
    await writeRun(runsDirectory, "run-b", {
      id: "run-b",
      benchmark: "demo",
      benchmarkDataRevision: "rev",
      model: "model-b"
    }, [result("demo/3", false)]);
    await writeRun(runsDirectory, "ignored", {
      id: "ignored",
      benchmark: "other",
      benchmarkDataRevision: "rev",
      model: "model-c"
    }, [result("other/3", true)]);

    const report = await analyzeArchive({
      runsDirectory,
      benchmark: "demo",
      revision: "rev",
      model: null,
      includeContent: false
    });
    expect(report).toMatchObject({ runsRead: 2, attempts: 2 });
    expect(report.cases[0]).toMatchObject({
      taskId: "demo/3",
      triage: "broad-cross-model-failure",
      failedModels: 2,
      semanticModels: 2
    });
    const markdown = markdownFailureReport(report, { minModels: 2, limit: 10 });
    expect(markdown).toContain("demo/3");
    expect(markdown).toContain("broad-cross-model-failure");
    expect(markdown).not.toContain("private prompt");
  });
});
