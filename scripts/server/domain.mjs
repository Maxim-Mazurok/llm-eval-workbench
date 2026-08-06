export const defaultSystemPrompt = [
  "You are completing a Python programming task.",
  "Implement the requested function exactly as described.",
  "Prioritize functional correctness above all else.",
  "Use straightforward, readable Python.",
  "Use only the Python standard library.",
  "Return only the requested code. Do not include explanations."
].join("\n");

export const defaultPromptTemplate = [
  "Goal:",
  "- Implement the function described by the signature, type hints, docstring, examples, and surrounding context.",
  "- Return Python code that can be executed by a test harness.",
  "",
  "Response format:",
  "- Output one markdown multiline code block with python syntax.",
  "- Returning the complete code, including everything required to run: the original signature function, any supporting functions that were already implemented, and any required imports (from standard libraries only).",
  "- Preserve the function name(s), arguments, and return behavior implied by the prompt.",
  "",
  "Task prompt:",
  "```python",
  "%problem_code%",
  "```"
].join("\n");

export function compactResult(result) {
  if (!result) return result;
  const {
    rawOutput,
    thinkingOutput,
    rawTranscript,
    extractedCode,
    harnessStdout,
    harnessStderr,
    stdout,
    stderr,
    prompt,
    test,
    instructionPrompt,
    ...rest
  } = result;
  return {
    ...rest,
    tests: result.tests || [],
    error: result.error || null,
    traceback: result.traceback || null,
    generationMs: result.generationMs
  };
}

// Clamp a benchmark-reported task score into [0, 1]; results without one
// (binary benchmarks, legacy persisted runs) fall back to 1/0 from `passed`.
export function normalizeTaskScore(score, passed) {
  const numeric = Number(score);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  return passed ? 1 : 0;
}

export function runScoreSum(results = []) {
  return results.reduce((sum, result) => sum + normalizeTaskScore(result.score, result.passed), 0);
}

export function runSummary(run, { includeResults = true } = {}) {
  const { completed, passed, failed } = runCountsFromResults(run.results);
  const scoreSum = runScoreSum(run.results);
  const assertionsTotal = run.results.reduce((sum, result) => sum + (result.tests?.length || 0), 0);
  const assertionsPassed = run.results.reduce(
    (sum, result) => sum + (result.tests || []).filter((test) => test.passed).length,
    0
  );
  return {
    id: run.id,
    status: run.status,
    benchmark: run.benchmark || "humaneval",
    benchmarkDataRevision: run.benchmarkDataRevision || null,
    model: run.model,
    baseUrl: run.baseUrl,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    total: run.total,
    completed,
    passed,
    failed,
    liveScore: completed ? passed / completed : 0,
    finalScore: run.total ? passed / run.total : null,
    // Mean of per-task [0,1] scores; equals the pass rate for binary
    // benchmarks and the graded average for scored ones.
    meanScore: completed ? scoreSum / completed : 0,
    finalMeanScore: run.total ? scoreSum / run.total : null,
    assertionsPassed,
    assertionsTotal,
    assertionScore: assertionsTotal ? assertionsPassed / assertionsTotal : 0,
    currentTaskId: run.currentTaskId,
    activeTaskIds: run.activeTaskIds || [],
    activeTaskStartedAt: run.activeTaskStartedAt || {},
    config: {
      baseUrl: run.baseUrl,
      model: run.model,
      benchmark: run.benchmark || "humaneval",
      parallelTasks: run.parallelTasks || 1,
      passCount: run.passCount || 1,
      ...(run.publicConfig || {})
    },
    logDir: run.dir,
    selectedIndices: run.selectedIndices,
    results: includeResults ? run.results : []
  };
}

export function persistedRunState(run) {
  return runSummary(run, { includeResults: false });
}

export function runtimeConfigFromPersistedRun(persisted) {
  const persistedConfig = persisted.config || persisted.publicConfig || {};
  return {
    benchmark: String(persistedConfig.benchmark ?? persisted.benchmark ?? "humaneval"),
    publicConfig: {
      ...persistedConfig,
      apiKey: redactApiKey(persistedConfig.apiKey)
    },
    apiKey: persistedConfig.apiKey === "***" ? "" : String(persistedConfig.apiKey || "").trim(),
    temperature: Number(persistedConfig.temperature ?? persisted.temperature ?? 0),
    // Legacy runs persisted a single `maxTokens` before the thinking-budget
    // split; fall back to it so resuming an old run keeps its original token
    // budget instead of silently dropping to the 2048 default.
    maxOutputTokens: normalizeTokenCount(
      persistedConfig.maxOutputTokens
        ?? persisted.maxOutputTokens
        ?? persistedConfig.maxTokens
        ?? persisted.maxTokens,
      2048
    ),
    thinkingEnabled: (persistedConfig.thinkingEnabled ?? persisted.thinkingEnabled) !== false,
    thinkingBudget: normalizeTokenCount(persistedConfig.thinkingBudget ?? persisted.thinkingBudget, 8192),
    timeoutSeconds: Number(persistedConfig.timeoutSeconds ?? persisted.timeoutSeconds ?? 15),
    sampleLimit: Number(persistedConfig.sampleLimit ?? persisted.sampleLimit ?? 0),
    startIndex: Number(persistedConfig.startIndex ?? persisted.startIndex ?? 0),
    systemPrompt: String(persistedConfig.systemPrompt ?? persisted.systemPrompt ?? defaultSystemPrompt),
    promptTemplate: String(persistedConfig.promptTemplate ?? persisted.promptTemplate ?? defaultPromptTemplate),
    extraBody: persistedConfig.extraBody && typeof persistedConfig.extraBody === "object" ? persistedConfig.extraBody : {},
    adaptiveRepetitionPenalty: Boolean(persistedConfig.adaptiveRepetitionPenalty),
    repetitionPenalty: Number(persistedConfig.repetitionPenalty ?? 1),
    parallelTasks: normalizeParallelTasks(persistedConfig.parallelTasks ?? persisted.parallelTasks),
    passCount: normalizePassCount(persistedConfig.passCount ?? persisted.passCount)
  };
}

export function resultAttemptId(result) {
  if (result.attemptId) return result.attemptId;
  if (!result.taskId) return null;
  return `${result.taskId}::pass-${result.passNumber || 1}`;
}

export function eventAttemptId(event) {
  const taskId = event.data?.taskId;
  if (!taskId) return null;
  if (typeof event.data.attemptId === "string") return event.data.attemptId;
  return `${taskId}::pass-${event.data.passNumber || 1}`;
}

export function runCountsFromResults(results = []) {
  const completed = results.length;
  const passed = results.filter((result) => result.passed).length;
  return { completed, passed, failed: completed - passed };
}

export function syncRunCountsFromResults(run) {
  const { completed, passed, failed } = runCountsFromResults(run.results);
  run.completed = completed;
  run.passed = passed;
  run.failed = failed;
}

const resumeDiscardEventTypes = new Set(["error", "token", "raw", "raw-delta", "code-extracted"]);

export function discardResumeArtifacts(run) {
  const retainedResults = run.results.filter((result) => !result.modelError);
  const retainedAttemptIds = new Set(retainedResults.map(resultAttemptId).filter(Boolean));
  run.results = retainedResults;
  run.events = run.events.filter((event) => {
    if (resumeDiscardEventTypes.has(event.type)) return false;
    const attemptId = eventAttemptId(event);
    if (!attemptId) return true;
    return retainedAttemptIds.has(attemptId);
  });
  syncRunCountsFromResults(run);
}

export function redactApiKey(value) {
  return String(value || "").trim() ? "***" : "";
}

export function formatRunDirTimestamp(value) {
  return new Date(value).toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function slugifyRunPart(value, fallback = "model") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function runDirName(run) {
  return [
    formatRunDirTimestamp(run.startedAt || run.createdAt),
    slugifyRunPart(run.model),
    ...(run.benchmark && run.benchmark !== "humaneval" ? [slugifyRunPart(run.benchmark)] : []),
    run.id
  ].join("-");
}

export function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL is required.");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function extractTextFromDelta(delta) {
  const parts = [];
  if (typeof delta.reasoning_content === "string") parts.push({ channel: "thinking", text: delta.reasoning_content });
  if (typeof delta.reasoning === "string") parts.push({ channel: "thinking", text: delta.reasoning });
  if (typeof delta.thinking === "string") parts.push({ channel: "thinking", text: delta.thinking });
  if (typeof delta.content === "string") parts.push({ channel: "output", text: delta.content });
  if (typeof delta.refusal === "string") parts.push({ channel: "refusal", text: delta.refusal });
  return parts;
}

export function renderPromptTemplate(template, problem) {
  // Use replacement callbacks so "$" sequences in task text are inserted
  // literally instead of being interpreted as replacement patterns.
  return String(template || defaultPromptTemplate)
    .replaceAll("%problem_code%", () => problem.prompt)
    .replaceAll("%problem%", () => problem.prompt);
}

export function buildPromptMessages(problem, systemPrompt = defaultSystemPrompt, promptTemplate = defaultPromptTemplate) {
  const messages = [];
  if (String(systemPrompt || "").trim()) {
    messages.push({ role: "system", content: String(systemPrompt).trim() });
  }
  messages.push({ role: "user", content: renderPromptTemplate(promptTemplate, problem) });
  return messages;
}

export function extractCodeFromOutput(output, prompt) {
  const text = String(output || "").trim();
  const pythonBlocks = [...text.matchAll(/(?:^|\n)[ \t]*```[ \t]*python[ \t]*(?:\r?\n|$)([\s\S]*?)(?:(?:\r?\n)[ \t]*```[ \t]*(?=\r?\n|$)|$)/gi)];
  if (pythonBlocks.length) {
    const code = pythonBlocks[pythonBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  const genericBlocks = [...text.matchAll(/(?:^|\n)[ \t]*```[ \t]*(?:\r?\n|$)([\s\S]*?)(?:(?:\r?\n)[ \t]*```[ \t]*(?=\r?\n|$)|$)/g)];
  if (genericBlocks.length) {
    const code = genericBlocks[genericBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  if (text.startsWith("def ") || text.startsWith("import ") || text.startsWith("from ")) return text;
  return prompt + text;
}

export function parseTestNumbers(value, datasetSize, taskIdPattern = /HumanEval\/(\d+)$/i) {
  if (Array.isArray(value)) {
    const selected = [...new Set(value.map(Number).filter((number) => Number.isInteger(number)))].sort((a, b) => a - b);
    const invalid = selected.filter((index) => index < 0 || index >= datasetSize);
    if (invalid.length) {
      throw new Error(`Invalid test number(s): ${invalid.join(", ")}. Use 0-${datasetSize - 1}.`);
    }
    return selected;
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  const selected = new Set();
  const invalid = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const first = Number(range[1]);
      const last = Number(range[2]);
      const step = first <= last ? 1 : -1;
      for (let index = first; step > 0 ? index <= last : index >= last; index += step) selected.add(index);
      continue;
    }
    const task = taskIdPattern ? part.match(taskIdPattern) : null;
    const index = Number(task ? task[1] : part);
    if (!Number.isInteger(index)) {
      invalid.push(part);
      continue;
    }
    selected.add(index);
  }
  invalid.push(...[...selected].filter((index) => index < 0 || index >= datasetSize));
  if (invalid.length) {
    throw new Error(`Invalid test number(s): ${invalid.join(", ")}. Use 0-${datasetSize - 1}.`);
  }
  return [...selected].sort((a, b) => a - b);
}

export function normalizeTaskCount(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function normalizeTokenCount(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function normalizeParallelTasks(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(64, Math.max(1, Math.floor(parsed)));
}

export function normalizePassCount(value) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}
