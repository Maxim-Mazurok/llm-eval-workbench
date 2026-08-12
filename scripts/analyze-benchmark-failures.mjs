#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedScore(result) {
  const answerScore = finiteNumber(result.answerScore);
  if (answerScore !== null) return Math.min(1, Math.max(0, answerScore));
  return result.passed ? 1 : 0;
}

export function resultFailureKind(result) {
  if (result.modelError) return "model-error";
  if (result.looping || result.loopDetection) return "loop";
  if (String(result.finishReason || "").toLowerCase() === "length") return "truncated";
  if (result.timeout) return "timeout";
  if (!result.passed && (!Array.isArray(result.tests) || result.tests.length === 0)) {
    return "evaluation-error";
  }
  return result.passed ? "pass" : "semantic-failure";
}

export async function discoverBenchmarkResults(runsDirectory, filters = {}) {
  const entries = await fs.readdir(runsDirectory, { withFileTypes: true });
  const attempts = [];
  const loadErrors = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(runsDirectory, entry.name);
    try {
      const [runText, resultsText] = await Promise.all([
        fs.readFile(join(directory, "run.json"), "utf8"),
        fs.readFile(join(directory, "results.json"), "utf8")
      ]);
      const run = JSON.parse(runText);
      const results = JSON.parse(resultsText);
      if (!Array.isArray(results)) throw new Error("results.json is not an array");
      const benchmark = String(run?.benchmark ?? run?.config?.benchmark ?? "unknown");
      const revision = String(run?.benchmarkDataRevision ?? "unversioned");
      const model = String(run?.model ?? run?.config?.model ?? "unknown");
      if (filters.benchmark && benchmark !== filters.benchmark) continue;
      if (filters.revision && revision !== filters.revision) continue;
      if (filters.model && !model.toLowerCase().includes(filters.model.toLowerCase())) continue;

      results.forEach((result, resultIndex) => {
        if (!result || typeof result !== "object") return;
        attempts.push({
          benchmark,
          revision,
          model,
          runId: String(run?.id ?? entry.name),
          runDirectory: entry.name,
          resultIndex,
          result
        });
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      loadErrors.push({
        runDirectory: entry.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { attempts, loadErrors };
}

function representativeContent(attempts) {
  const first = attempts[0]?.result ?? {};
  const sampleFailures = attempts
    .filter(({ result }) => resultFailureKind(result) === "semantic-failure")
    .slice(0, 3)
    .map(({ model, result }) => ({
      model,
      answer: String(result.extractedCode ?? result.rawOutput ?? "").slice(0, 1200),
      tests: Array.isArray(result.tests) ? result.tests : []
    }));
  return {
    prompt: String(first.prompt ?? ""),
    expectedAnswer: String(first.expectedAnswer ?? first.test ?? ""),
    sampleFailures
  };
}

function triageLabel({ expectedConflict, attempts, infrastructureAttempts, semanticModels, failedModels }) {
  if (expectedConflict) return "expected-answer-conflict";
  if (attempts > 0 && infrastructureAttempts / attempts >= 0.5) return "infrastructure-dominated";
  if (semanticModels < 2) return "insufficient-evidence";
  const failureRate = failedModels / semanticModels;
  if (failureRate >= 0.75) return "broad-cross-model-failure";
  if (failureRate >= 0.25) return "cross-model-split";
  if (failureRate > 0) return "model-specific-failure";
  return "consistently-passed";
}

export function aggregateBenchmarkFailures(attempts, { includeContent = false } = {}) {
  const groups = new Map();
  for (const attempt of attempts) {
    const taskId = String(attempt.result.taskId ?? `index:${attempt.result.index ?? attempt.resultIndex}`);
    const key = `${attempt.benchmark}\u0000${attempt.revision}\u0000${taskId}`;
    const group = groups.get(key) ?? {
      benchmark: attempt.benchmark,
      revision: attempt.revision,
      taskId,
      attempts: []
    };
    group.attempts.push(attempt);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const byModel = new Map();
    const expectedAnswers = new Set();
    const failureKinds = {};
    for (const attempt of group.attempts) {
      const kind = resultFailureKind(attempt.result);
      failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
      const expected = String(attempt.result.expectedAnswer ?? attempt.result.test ?? "").trim();
      if (expected) expectedAnswers.add(expected);
      const bucket = byModel.get(attempt.model) ?? { semanticScores: [], infrastructure: 0, attempts: 0 };
      bucket.attempts += 1;
      if (kind === "pass" || kind === "semantic-failure") {
        bucket.semanticScores.push(normalizedScore(attempt.result));
      } else {
        bucket.infrastructure += 1;
      }
      byModel.set(attempt.model, bucket);
    }

    const modelSummaries = [...byModel.entries()].map(([model, bucket]) => {
      const meanAnswerScore = bucket.semanticScores.length === 0
        ? null
        : bucket.semanticScores.reduce((sum, score) => sum + score, 0) / bucket.semanticScores.length;
      return {
        model,
        attempts: bucket.attempts,
        semanticAttempts: bucket.semanticScores.length,
        infrastructureAttempts: bucket.infrastructure,
        meanAnswerScore,
        failed: meanAnswerScore !== null && meanAnswerScore < 0.5,
        unstable: bucket.semanticScores.some((score) => score >= 0.5)
          && bucket.semanticScores.some((score) => score < 0.5)
      };
    });
    const scoredModels = modelSummaries.filter((model) => model.meanAnswerScore !== null);
    const failedModels = scoredModels.filter((model) => model.failed).length;
    const unstableModels = scoredModels.filter((model) => model.unstable).length;
    const semanticAttempts = scoredModels.reduce((sum, model) => sum + model.semanticAttempts, 0);
    const meanAnswerScore = scoredModels.length === 0
      ? null
      : scoredModels.reduce((sum, model) => sum + model.meanAnswerScore, 0) / scoredModels.length;
    const infrastructureAttempts = group.attempts.length
      - semanticAttempts;
    const expectedConflict = expectedAnswers.size > 1;
    const label = triageLabel({
      expectedConflict,
      attempts: group.attempts.length,
      infrastructureAttempts,
      semanticModels: scoredModels.length,
      failedModels
    });
    const modelFailureRate = scoredModels.length === 0 ? null : failedModels / scoredModels.length;
    const evidenceFactor = Math.min(1, scoredModels.length / 4);
    const reviewPriority = expectedConflict
      ? 100
      : Math.round(100 * (
          0.55 * (modelFailureRate ?? 0)
          + 0.25 * (1 - (meanAnswerScore ?? 1))
          + 0.15 * evidenceFactor
          + 0.05 * Math.min(1, unstableModels / Math.max(1, scoredModels.length))
        ));

    return {
      benchmark: group.benchmark,
      revision: group.revision,
      taskId: group.taskId,
      index: finiteNumber(group.attempts[0]?.result.index),
      triage: label,
      reviewPriority,
      attempts: group.attempts.length,
      runs: new Set(group.attempts.map((attempt) => attempt.runId)).size,
      models: byModel.size,
      semanticModels: scoredModels.length,
      failedModels,
      unstableModels,
      modelFailureRate,
      meanAnswerScore,
      infrastructureAttempts,
      failureKinds,
      expectedConflict,
      modelSummaries,
      ...(includeContent ? { content: representativeContent(group.attempts) } : {})
    };
  }).sort((left, right) =>
    right.reviewPriority - left.reviewPriority
    || right.semanticModels - left.semanticModels
    || left.taskId.localeCompare(right.taskId)
  );
}

function parseJsonObject(text) {
  const value = String(text ?? "").trim();
  const unfenced = value.startsWith("```")
    ? value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : value;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("Judge response did not contain a JSON object");
  return JSON.parse(unfenced.slice(start, end + 1));
}

function judgeCandidate(entry, minModels) {
  if (entry.expectedConflict) return true;
  if (entry.semanticModels < minModels) return false;
  return entry.triage === "broad-cross-model-failure"
    || entry.triage === "cross-model-split"
    || entry.triage === "model-specific-failure";
}

export async function adjudicateFailureCases(cases, {
  model,
  baseUrl = "http://127.0.0.1:8000/v1",
  apiKey = null,
  minModels = 2,
  limit = 10,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!model) throw new Error("A judge model is required");
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this Node runtime");
  const candidates = cases.filter((entry) => judgeCandidate(entry, minModels)).slice(0, limit);
  if (candidates.length === 0) return [];

  const payload = candidates.map((entry) => ({
    caseId: `${entry.benchmark}\u0000${entry.revision}\u0000${entry.taskId}`,
    benchmark: entry.benchmark,
    revision: entry.revision,
    taskId: entry.taskId,
    aggregate: {
      triage: entry.triage,
      semanticModels: entry.semanticModels,
      failedModels: entry.failedModels,
      modelFailureRate: entry.modelFailureRate,
      meanAnswerScore: entry.meanAnswerScore,
      infrastructureAttempts: entry.infrastructureAttempts,
      attempts: entry.attempts
    },
    prompt: entry.content?.prompt ?? "",
    expectedAnswer: entry.content?.expectedAnswer ?? "",
    sampleFailedAnswers: (entry.content?.sampleFailures ?? []).slice(0, 2).map((failure) => ({
      model: failure.model,
      answer: String(failure.answer ?? "").slice(0, 800)
    }))
  }));
  const system = [
    "You audit benchmark cases, not the people or subjects mentioned in them.",
    "Decide whether repeated misses are most likely an actual model capability failure or a benchmark/data problem.",
    "Judge only what the benchmark prompt makes knowable; never assume hidden metadata.",
    "Use exactly one label: model_failure, benchmark_issue, or ambiguous_needs_review.",
    "A benchmark issue includes wrong ground truth, insufficient prompt context, or broken scoring.",
    "Use ambiguous_needs_review when the supplied evidence is inconclusive.",
    "Return valid JSON only in this form:",
    '{"cases":[{"caseId":"...","label":"...","confidence":0.0,"reason":"short reason"}]}'
  ].join(" ");
  const endpoint = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Judge request failed (${response.status}): ${await response.text()}`);
  const body = await response.json();
  const parsed = parseJsonObject(body?.choices?.[0]?.message?.content);
  if (!Array.isArray(parsed.cases)) throw new Error("Judge response JSON did not contain a cases array");
  const allowedLabels = new Set(["model_failure", "benchmark_issue", "ambiguous_needs_review"]);
  const adjudications = parsed.cases.map((entry) => {
    if (!payload.some((candidate) => candidate.caseId === entry.caseId)) {
      throw new Error(`Judge returned an unknown caseId: ${entry.caseId}`);
    }
    if (!allowedLabels.has(entry.label)) throw new Error(`Judge returned an invalid label: ${entry.label}`);
    return {
      caseId: entry.caseId,
      label: entry.label,
      confidence: Math.min(1, Math.max(0, finiteNumber(entry.confidence) ?? 0)),
      reason: String(entry.reason ?? "").slice(0, 500)
    };
  });
  const returnedIds = new Set(adjudications.map((entry) => entry.caseId));
  const missing = payload.find((candidate) => !returnedIds.has(candidate.caseId));
  if (missing) throw new Error(`Judge omitted caseId: ${missing.caseId}`);
  return adjudications;
}

function attachAdjudications(cases, adjudications) {
  const byId = new Map(adjudications.map((entry) => [entry.caseId, entry]));
  return cases.map((entry) => {
    const caseId = `${entry.benchmark}\u0000${entry.revision}\u0000${entry.taskId}`;
    const adjudication = byId.get(caseId);
    return adjudication ? { ...entry, adjudication: {
      label: adjudication.label,
      confidence: adjudication.confidence,
      reason: adjudication.reason
    } } : entry;
  });
}

function percentage(value) {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

export function markdownFailureReport(report, { limit = 25, minModels = 2 } = {}) {
  const cases = report.cases
    .filter((entry) => entry.semanticModels >= minModels || entry.expectedConflict)
    .slice(0, limit);
  const lines = [
    "# Benchmark failure analysis",
    "",
    `Runs read: ${report.runsRead}; attempts: ${report.attempts}; grouped cases: ${report.cases.length}`,
    `Filters: benchmark=${report.filters.benchmark ?? "all"}, revision=${report.filters.revision ?? "all"}, model=${report.filters.model ?? "all"}`,
    "",
    "Grouping is revision-scoped. A task ID is never compared across dataset revisions.",
    "Repeated failures nominate cases for review; they do not prove bad ground truth.",
    "",
    "| Priority | Benchmark | Revision | Task | Triage | Failed models | Mean answer | Infra | Judge |",
    "| ---: | --- | --- | --- | --- | ---: | ---: | ---: | --- |"
  ];
  for (const entry of cases) {
    lines.push(
      `| ${entry.reviewPriority} | ${entry.benchmark} | ${entry.revision} | ${entry.taskId} | ${entry.triage} | ${entry.failedModels}/${entry.semanticModels} | ${percentage(entry.meanAnswerScore)} | ${entry.infrastructureAttempts}/${entry.attempts} | ${entry.adjudication ? `${entry.adjudication.label} (${percentage(entry.adjudication.confidence)})` : "-"} |`
    );
  }
  if (report.loadErrors.length > 0) {
    lines.push("", `Unreadable run directories: ${report.loadErrors.length}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = {
    runsDirectory: join(rootDirectory, "benchmark-runs"),
    benchmark: null,
    revision: null,
    model: null,
    minModels: 2,
    limit: 25,
    json: false,
    includeContent: false,
    judgeModel: null,
    judgeBaseUrl: "http://127.0.0.1:8000/v1",
    judgeApiKeyEnv: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--runs" && value) {
      options.runsDirectory = resolve(value);
      index += 1;
    } else if (argument === "--benchmark" && value) {
      options.benchmark = value;
      index += 1;
    } else if (argument === "--revision" && value) {
      options.revision = value;
      index += 1;
    } else if (argument === "--model" && value) {
      options.model = value;
      index += 1;
    } else if (argument === "--min-models" && value) {
      options.minModels = Math.max(1, Number.parseInt(value, 10) || 1);
      index += 1;
    } else if (argument === "--limit" && value) {
      options.limit = Math.max(1, Number.parseInt(value, 10) || 25);
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--include-content") {
      options.includeContent = true;
    } else if (argument === "--judge-model" && value) {
      options.judgeModel = value;
      index += 1;
    } else if (argument === "--judge-base-url" && value) {
      options.judgeBaseUrl = value;
      index += 1;
    } else if (argument === "--judge-api-key-env" && value) {
      options.judgeApiKeyEnv = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/analyze-benchmark-failures.mjs [options]",
    "",
    "  --runs <dir>          run archive (default: benchmark-runs)",
    "  --benchmark <id>      exact benchmark id",
    "  --revision <id>       exact benchmark data revision",
    "  --model <text>        case-insensitive model substring",
    "  --min-models <n>      report cases tried by at least n models (default: 2)",
    "  --limit <n>           maximum reported cases (default: 25)",
    "  --json                emit machine-readable JSON",
    "  --include-content     include prompts, expected answers, and sample failures",
    "  --judge-model <id>    opt in to model-assisted adjudication of reported failures",
    "  --judge-base-url <url> OpenAI-compatible base URL (default: local oMLX)",
    "  --judge-api-key-env <name> environment variable containing the judge API key",
    "  -h, --help            show this help",
    "",
    "Content is omitted by default because saved prompts and outputs may be sensitive.",
    "A judge receives case content; use a local or otherwise trusted endpoint."
  ].join("\n");
}

export async function analyzeArchive(options) {
  const discovered = await discoverBenchmarkResults(options.runsDirectory, options);
  const needsContent = options.includeContent || Boolean(options.judgeModel);
  let cases = aggregateBenchmarkFailures(discovered.attempts, { ...options, includeContent: needsContent });
  if (options.judgeModel) {
    const apiKey = options.judgeApiKeyEnv ? process.env[options.judgeApiKeyEnv] : null;
    if (options.judgeApiKeyEnv && !apiKey) {
      throw new Error(`Judge API key environment variable is not set: ${options.judgeApiKeyEnv}`);
    }
    const adjudications = await adjudicateFailureCases(cases, {
      model: options.judgeModel,
      baseUrl: options.judgeBaseUrl,
      apiKey,
      minModels: options.minModels,
      limit: options.limit
    });
    cases = attachAdjudications(cases, adjudications);
  }
  if (!options.includeContent) cases = cases.map(({ content, ...entry }) => entry.adjudication
    ? { ...entry, adjudication: {
        label: entry.adjudication.label,
        confidence: entry.adjudication.confidence
      } }
    : entry);
  return {
    generatedAt: new Date().toISOString(),
    runsDirectory: options.runsDirectory,
    filters: {
      benchmark: options.benchmark,
      revision: options.revision,
      model: options.model,
      judgeModel: options.judgeModel
    },
    runsRead: new Set(discovered.attempts.map((attempt) => attempt.runId)).size,
    attempts: discovered.attempts.length,
    cases,
    loadErrors: discovered.loadErrors
  };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const report = await analyzeArchive(options);
      process.stdout.write(options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : markdownFailureReport(report, options));
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
