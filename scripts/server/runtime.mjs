#!/usr/bin/env node
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPromptMessages,
  compactResult,
  discardResumeArtifacts,
  extractTextFromDelta,
  isLocalBaseUrl,
  normalizeBaseUrl,
  normalizeParallelTasks,
  normalizePassCount,
  normalizeTaskCount,
  normalizeTaskScore,
  normalizeTokenCount,
  parseTestNumbers,
  persistedRunState,
  redactApiKey,
  resultAttemptId,
  runDirName,
  runHasModelErrorResults,
  runtimeConfigFromPersistedRun,
  runSummary,
  syncRunCountsFromResults
} from "./domain.mjs";
import { createProviderStore } from "./providerStore.mjs";
import { benchmarkSummaries, benchmarks, getBenchmark } from "./benchmarks/registry.mjs";
import { createLmStudioChatCompletionResponse } from "./lmStudioModel.mjs";
import { fetchModelResponseWithRetry, throwIfRetryableModelOutput } from "./modelRetry.mjs";
import {
  detectRepetitionLoop,
  detectTokenLimitRepetitionLoop,
  initialRepetitionPenalty,
  LOOP_DETECTION_CONFIG,
  nextAdaptiveRepetitionPenalty,
  restoreAdaptiveRepetitionPenaltyState
} from "./repetitionDetector.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// LLM_EVAL_ROOT_DIR relocates benchmark-runs/ and .cache/ (Playwright starts
// a throwaway server that must never share artifacts with a live one).
const defaultRootDir = process.env.LLM_EVAL_ROOT_DIR || join(__dirname, "../..");
const LOOP_DETECTION_CHECK_INTERVAL_CHARACTERS = 512;

// Benchmarks that ship binary assets (photographs, audio, ...) expose
// `resolveAssetPath(file)`; the runtime serves whatever that returns and knows
// nothing about where a pack keeps its data.
export const BENCHMARK_ASSET_ROUTE_PREFIX = "/api/benchmark-assets/";

const ASSET_CONTENT_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
  ["gif", "image/gif"]
]);

export function benchmarkAssetUrl(benchmarkId, file) {
  return `${BENCHMARK_ASSET_ROUTE_PREFIX}${encodeURIComponent(benchmarkId)}/${encodeURIComponent(file)}`;
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

export function createRuntimeServer({
  rootDir = defaultRootDir,
  port = Number(process.env.LLM_EVAL_PORT || 8787),
  performanceLogEnabled = process.env.LLM_EVAL_PERFORMANCE_LOG === "1",
  fetchImplementation = fetch,
  maxReplayEvents = 5000,
  providerStore: configuredProviderStore,
  lmStudioClientFactory
} = {}) {
  const cacheDir = join(rootDir, ".cache");
  const configDir = join(rootDir, ".config");
  const runsDir = join(rootDir, "benchmark-runs");
  const providerStore = configuredProviderStore || createProviderStore({ configDir });
  const runs = new Map();
  const taskLogWriteQueues = new Map();
  // Each saved remote provider gets an independent FIFO and can benchmark at
  // the same time as other providers. Every loopback address deliberately
  // collapses into one shared lane, regardless of port or provider id: two
  // local model servers competing for the same RAM/GPU is exactly the case we
  // must never run concurrently.
  const runQueues = new Map();
  const activeRunIds = new Map();

  function schedulerKeyForRun(run) {
    if (isLocalBaseUrl(run.baseUrl)) return "local";
    if (run.providerId) return `provider:${run.providerId}`;
    return `endpoint:${run.baseUrl}`;
  }

  function queueForRun(run) {
    const key = schedulerKeyForRun(run);
    let queue = runQueues.get(key);
    if (!queue) {
      queue = [];
      runQueues.set(key, queue);
    }
    return { key, queue };
  }

  function syncQueuePositions() {
    for (const run of runs.values()) {
      const queue = runQueues.get(schedulerKeyForRun(run)) || [];
      const queueIndex = queue.indexOf(run.id);
      run.queuePosition = queueIndex === -1 ? null : queueIndex + 1;
    }
  }

  function enqueueRun(run) {
    run.status = "queued";
    run.queuedAt = new Date().toISOString();
    const { key, queue } = queueForRun(run);
    run.schedulerKey = key;
    queue.push(run.id);
    syncQueuePositions();
    // A run can wait in line for hours before anything else touches disk, and
    // a restart only restores runs that have artifacts; persist now so a
    // waiting run reloads as "interrupted" (resumable) instead of vanishing.
    persistRunArtifacts(run);
    // Deferred so the HTTP response that triggered the enqueue serializes the
    // "queued" state before the run (possibly) flips to "running".
    queueMicrotask(processQueue);
    return run;
  }

  function dequeueRun(run) {
    const key = run.schedulerKey || schedulerKeyForRun(run);
    const queue = runQueues.get(key);
    const queueIndex = queue?.indexOf(run.id) ?? -1;
    if (queueIndex !== -1) queue.splice(queueIndex, 1);
    if (queue?.length === 0 && !activeRunIds.has(key)) runQueues.delete(key);
    syncQueuePositions();
  }

  function processQueue() {
    for (const [key, queue] of runQueues) {
      const activeRun = runs.get(activeRunIds.get(key));
      if (activeRun && !activeRun.deleted && (activeRun.status === "running" || activeRun.status === "queued")) continue;
      activeRunIds.delete(key);

      let nextRun = null;
      while (queue.length && !nextRun) {
        const candidate = runs.get(queue.shift());
        if (candidate && !candidate.deleted && !candidate.cancelled && candidate.status === "queued") nextRun = candidate;
      }
      syncQueuePositions();
      if (!nextRun) {
        if (!queue.length) runQueues.delete(key);
        continue;
      }
      activeRunIds.set(key, nextRun.id);
      runBenchmark(nextRun).finally(() => {
        if (activeRunIds.get(key) === nextRun.id) activeRunIds.delete(key);
        if (!queue.length) runQueues.delete(key);
        processQueue();
      });
    }
  }

  function loadBenchmarkProblems(benchmark) {
    return benchmark.loadProblems({ cacheDir, fetchImplementation });
  }

  function logPerformance(fields) {
    if (!performanceLogEnabled) return;
    console.log(`[PERF] ${JSON.stringify({ at: new Date().toISOString(), ...fields })}`);
  }

  function runPerformanceMetrics(run) {
    if (!performanceLogEnabled) return null;
    run.performanceMetrics ??= {
      totalEventCount: 0,
      totalEventBytes: 0,
      eventTypes: {}
    };
    return run.performanceMetrics;
  }

  function sendJson(res, status, payload, performanceFields = {}) {
    const serializationStartedAt = performance.now();
    const serializedPayload = JSON.stringify(payload);
    const serializationMilliseconds = performance.now() - serializationStartedAt;
    const responseBytes = byteLength(serializedPayload);
    logPerformance({
      type: "json-response",
      status,
      responseBytes,
      serializationMilliseconds: Number(serializationMilliseconds.toFixed(3)),
      ...performanceFields
    });
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(responseBytes),
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    });
    res.end(serializedPayload);
  }

  async function readJsonBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  }

  function ensureRunDir(run) {
    if (!run.dir) run.dir = join(runsDir, runDirName(run));
    return run.dir;
  }

  // Write via a temp file plus rename so a process death mid-write leaves the
  // previous complete artifact in place instead of truncated JSON that would
  // fail to parse on reload and take resume down with it.
  async function writeFileAtomic(filePath, contents) {
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, filePath);
  }

  async function writeRunArtifacts(run) {
    if (run.deleted) return;
    ensureRunDir(run);
    await fs.mkdir(run.dir, { recursive: true });
    await Promise.all([
      writeFileAtomic(join(run.dir, "run.json"), JSON.stringify(persistedRunState(run), null, 2)),
      writeFileAtomic(join(run.dir, "results.json"), JSON.stringify(run.results, null, 2))
    ]);
  }

  const runPersistStates = new Map();

  // Serialize and coalesce artifact writes: frequent events (large runs finish
  // thousands of tasks) would otherwise start overlapping full-file rewrites.
  function persistRunArtifacts(run) {
    if (run.deleted) return;
    let state = runPersistStates.get(run.id);
    if (!state) {
      state = { writing: false, dirty: false };
      runPersistStates.set(run.id, state);
    }
    if (state.writing) {
      state.dirty = true;
      return;
    }
    state.writing = true;
    (async () => {
      do {
        state.dirty = false;
        await writeRunArtifacts(run).catch((error) => {
          console.error(`Failed to persist run ${run.id}:`, error);
        });
      } while (state.dirty && !run.deleted);
      state.writing = false;
    })();
  }

  async function appendTaskLogLine(run, entry) {
    if (run.deleted) return;
    ensureRunDir(run);
    const previous = taskLogWriteQueues.get(run.id) || Promise.resolve();
    const next = previous.then(async () => {
      if (run.deleted) return;
      await fs.mkdir(run.dir, { recursive: true });
      await fs.appendFile(join(run.dir, "task-logs.jsonl"), `${JSON.stringify(entry)}\n`);
    });
    taskLogWriteQueues.set(run.id, next.catch(() => {}));
    await next;
  }

  async function appendTaskLogs(run, result) {
    const base = {
      at: new Date().toISOString(),
      taskId: result.taskId,
      attemptId: result.attemptId,
      passNumber: result.passNumber,
      passTotal: result.passTotal,
      index: result.index,
      entryPoint: result.entryPoint,
      passed: result.passed
    };
    const entries = [
      { ...base, channel: "prompt", text: result.instructionPrompt || "" },
      { ...base, channel: "model-output", text: result.rawOutput || "" },
      { ...base, channel: "thinking-output", text: result.thinkingOutput || "" },
      { ...base, channel: "extracted-code", text: result.extractedCode || "" },
      { ...base, channel: "harness", text: result.traceback || result.error || result.harnessStderr || result.harnessStdout || "" }
    ];
    await Promise.all(entries.filter((entry) => entry.text).map((entry) => appendTaskLogLine(run, entry)));
  }

  function appendEvent(run, type, data = {}) {
    if (run.deleted) return;
    run.eventSeq = (run.eventSeq || 0) + 1;
    const event = {
      id: run.eventSeq,
      type,
      at: new Date().toISOString(),
      data
    };
    const serializedEvent = JSON.stringify(event);
    const eventBytes = byteLength(serializedEvent);
    const performanceMetrics = runPerformanceMetrics(run);
    if (performanceMetrics) {
      performanceMetrics.totalEventCount += 1;
      performanceMetrics.totalEventBytes += eventBytes;
      const eventTypeMetrics = performanceMetrics.eventTypes[type] || { count: 0, bytes: 0 };
      performanceMetrics.eventTypes[type] = {
        count: eventTypeMetrics.count + 1,
        bytes: eventTypeMetrics.bytes + eventBytes
      };
    }
    run.events.push(event);
    if (run.events.length > maxReplayEvents) run.events.splice(0, run.events.length - maxReplayEvents);
    if (type !== "token" && type !== "raw" && type !== "raw-delta") persistRunArtifacts(run);
    for (const res of run.clients) {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${type}\n`);
      res.write(`data: ${serializedEvent}\n\n`);
    }
  }

  function logTerminalRunPerformance(run, status) {
    const performanceMetrics = runPerformanceMetrics(run);
    if (!performanceMetrics) return;
    const largestEventType = Object.entries(performanceMetrics.eventTypes)
      .sort(([, left], [, right]) => right.bytes - left.bytes)[0];
    logPerformance({
      type: "run-terminal",
      runId: run.id,
      status,
      totalEventCount: performanceMetrics.totalEventCount,
      totalEventBytes: performanceMetrics.totalEventBytes,
      replayEventCount: run.events.length,
      resultCount: run.results.length,
      largestEventType: largestEventType ? largestEventType[0] : null,
      largestEventTypeBytes: largestEventType ? largestEventType[1].bytes : 0,
      tokenEventCount: performanceMetrics.eventTypes.token?.count || 0,
      tokenEventBytes: performanceMetrics.eventTypes.token?.bytes || 0,
      memoryRssBytes: process.memoryUsage().rss,
      memoryHeapUsedBytes: process.memoryUsage().heapUsed
    });
  }

  async function readModelResponse(response, run, problem, index, context, started) {
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`Model request failed: HTTP ${response.status} ${text.slice(0, 1000)}`);
    }

    let output = "";
    let thinking = "";
    let usage = null;
    let finishReason = null;
    let loopDetection = null;
    const lastLoopCheckCharacters = { thinking: 0, output: 0 };

    function consumeCompletionPayload(parsed) {
      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      // Streaming responses put tokens in `delta`; a few OpenAI-compatible
      // endpoints accept stream=true but return one ordinary completion with
      // the text in `message` instead. Treat both shapes identically.
      const responseParts = [choice?.delta, choice?.message]
        .filter((part) => part && typeof part === "object");
      const parts = responseParts.flatMap((part) => extractTextFromDelta(part));
      for (const part of parts) {
        if (part.channel === "output") output += part.text;
        if (part.channel === "thinking") thinking += part.text;
        appendEvent(run, "token", { taskId: problem.task_id, index, ...context, ...part });
      }
      if (!parts.length && responseParts.some((part) => Object.keys(part).length)) {
        appendEvent(run, "raw-delta", {
          taskId: problem.task_id,
          index,
          ...context,
          delta: responseParts.length === 1 ? responseParts[0] : responseParts
        });
      }
      const detectedLoop = detectStreamLoop();
      recordLoopDetection(detectedLoop);
      return detectedLoop;
    }

    function responseResult() {
      return {
        output,
        thinking,
        usage,
        finishReason: loopDetection && run.adaptiveRepetitionPenalty ? "loop" : finishReason,
        loopDetection,
        elapsedMs: Date.now() - started
      };
    }

    function detectStreamLoop(force = false) {
      for (const [channel, text] of [["thinking", thinking], ["output", output]]) {
        if (!force && text.length - lastLoopCheckCharacters[channel] < LOOP_DETECTION_CHECK_INTERVAL_CHARACTERS) continue;
        lastLoopCheckCharacters[channel] = text.length;
        const detection = detectRepetitionLoop(text);
        if (detection) return { channel, ...detection };
      }
      return null;
    }

    function recordLoopDetection(detection) {
      if (!detection || loopDetection) return;
      loopDetection = detection;
      appendEvent(run, "loop-detected", {
        taskId: problem.task_id,
        index,
        ...context,
        ...loopDetection
      });
    }

    // VLM Run currently returns a normal JSON completion despite stream=true.
    // Check the content type before consuming the ReadableStream as SSE so
    // charged completions cannot silently become empty benchmark answers.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const parsed = await response.json();
      const detectedLoop = consumeCompletionPayload(parsed);
      recordLoopDetection(detectStreamLoop(true) || detectTokenLimitRepetitionLoop({
        thinking,
        output,
        finishReason
      }));
      if (loopDetection && run.adaptiveRepetitionPenalty) return responseResult();
      throwIfRetryableModelOutput(thinking, output);
      if (!finishReason) finishReason = "stop";
      return responseResult();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedDoneMarker = false;
    function processFrame(frame) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          receivedDoneMarker = true;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          appendEvent(run, "raw", { taskId: problem.task_id, index, ...context, text: payload });
          continue;
        }
        const detectedLoop = consumeCompletionPayload(parsed);
        if (detectedLoop && run.adaptiveRepetitionPenalty) return true;
      }
      return false;
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (processFrame(frame) && run.adaptiveRepetitionPenalty) {
          await reader.cancel().catch(() => undefined);
          return responseResult();
        }
      }
    }
    // Some otherwise compatible servers omit the final SSE blank line. Do
    // not discard a charged completion merely because its last frame arrived
    // immediately before the connection closed.
    processFrame(buffer);
    recordLoopDetection(detectStreamLoop(true) || detectTokenLimitRepetitionLoop({
      thinking,
      output,
      finishReason
    }));
    if (loopDetection && run.adaptiveRepetitionPenalty) return responseResult();
    throwIfRetryableModelOutput(thinking, output);
    if (!receivedDoneMarker && !finishReason) {
      const error = new Error("Model response stream ended before completion.");
      error.name = "IncompleteModelResponseError";
      throw error;
    }
    return responseResult();
  }

  // Photograph references for the UI: file names plus a server URL the
  // frontend can load pixels from. Only names are persisted in events and
  // results — the bytes stay on disk and go over the wire once per request.
  function problemImageRefs(benchmark, problem) {
    const images = Array.isArray(problem.images) ? problem.images : [];
    if (!images.length) return undefined;
    return images.map((image) => {
      const file = String(image.file).split("/").pop();
      return {
        file,
        postedAt: image.postedAt ?? null,
        url: benchmarkAssetUrl(benchmark.id, file)
      };
    });
  }

  // Benchmarks whose problems carry images get them attached to the user
  // message as OpenAI image_url parts. The
  // base64 payloads go only on the wire — event logs keep the text messages
  // plus the file names, or every prompt event would embed megabytes of jpeg.
  async function attachProblemImages(messages, problem) {
    const images = Array.isArray(problem.images) ? problem.images : [];
    if (!images.length) return messages;
    const lastIndex = messages.length - 1;
    const parts = [{ type: "text", text: messages[lastIndex].content }];
    for (const image of images) {
      const bytes = await fs.readFile(image.file);
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` }
      });
    }
    return messages.map((message, messageIndex) => (
      messageIndex === lastIndex ? { ...message, content: parts } : message
    ));
  }

  async function callModel(run, problem, index, context = {}) {
    const controller = new AbortController();
    run.abortControllers ??= new Set();
    run.abortControllers.add(controller);
    run.abortController = controller;
    const messages = buildPromptMessages(problem, run.systemPrompt, run.promptTemplate);
    const wireMessages = await attachProblemImages(messages, problem);
    // OMLX caps reasoning with `thinking_budget` but still counts those tokens
    // against `max_tokens`, so the request budget is thinking plus output.
    const thinkingBudget = run.thinkingEnabled ? normalizeTokenCount(run.thinkingBudget, 0) : 0;
    const body = {
      model: run.model,
      messages: wireMessages,
      stream: true,
      temperature: run.temperature,
      max_tokens: thinkingBudget + run.maxOutputTokens,
      enable_thinking: run.thinkingEnabled,
      thinking_budget: thinkingBudget,
      chat_template_kwargs: { enable_thinking: run.thinkingEnabled },
      stream_options: { include_usage: true }
    };
    if (run.extraBody && Object.keys(run.extraBody).length) Object.assign(body, run.extraBody);
    if (!Number.isFinite(Number(body.repetition_penalty)) || Number(body.repetition_penalty) <= 0) {
      delete body.repetition_penalty;
    }
    if (Number.isFinite(context.repetitionPenalty)) body.repetition_penalty = context.repetitionPenalty;
    const lmStudioPredictionConfig = {
      maxTokens: normalizeTokenCount(body.max_tokens, thinkingBudget + run.maxOutputTokens),
      reasoningBudget: thinkingBudget,
      enableThinking: run.thinkingEnabled,
      temperature: Number(body.temperature),
      ...(Number.isFinite(Number(body.repetition_penalty))
        ? { repeatPenalty: Number(body.repetition_penalty) }
        : {})
    };

    appendEvent(run, "prompt", {
      taskId: problem.task_id,
      index,
      ...context,
      messages,
      ...(Array.isArray(problem.images) && problem.images.length
        ? { imageFiles: problem.images.map((image) => image.file) }
        : {}),
      request: run.usesLmStudioSdk
        ? { transport: "lmstudio-sdk", model: run.model, messages, predictionConfig: lmStudioPredictionConfig }
        : { ...body, messages }
    });
    const started = Date.now();
    try {
      return await fetchModelResponseWithRetry({
        fetchImplementation: run.usesLmStudioSdk
          ? () => createLmStudioChatCompletionResponse({
              baseUrl: run.baseUrl,
              apiKey: run.apiKey,
              model: run.model,
              messages,
              predictionConfig: lmStudioPredictionConfig,
              signal: controller.signal,
              clientFactory: lmStudioClientFactory
            })
          : fetchImplementation,
        requestUrl: run.usesLmStudioSdk ? run.baseUrl : `${run.baseUrl}/chat/completions`,
        requestOptions: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(run.apiKey ? { authorization: `Bearer ${run.apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        },
        signal: controller.signal,
        shouldStop: () => run.cancelled,
        processResponse: (response) => readModelResponse(response, run, problem, index, context, started),
        onRetry: ({ attemptNumber, errorMessage, retryDelayMilliseconds }) => {
          appendEvent(run, "model-retry", { taskId: problem.task_id, index, ...context, attemptNumber, error: errorMessage, retryDelayMilliseconds });
        }
      });
    } finally {
      run.abortControllers?.delete(controller);
      if (run.abortController === controller) run.abortController = null;
    }
  }

  async function runBenchmark(run) {
    if (run.deleted || run.cancelled) return;
    run.status = "running";
    run.startedAt = run.startedAt || new Date().toISOString();
    run.finishedAt = null;
    ensureRunDir(run);
    try {
      const benchmark = getBenchmark(run.benchmark);
      const allProblems = await loadBenchmarkProblems(benchmark);
      const selectedIndices = run.selectedIndices?.length
        ? run.selectedIndices
        : (() => {
            const start = normalizeTaskCount(run.startIndex);
            const sampleLimit = normalizeTaskCount(run.sampleLimit);
            const end = sampleLimit > 0 ? Math.min(allProblems.length, start + sampleLimit) : allProblems.length;
            return Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
          })();
      run.selectedIndices = selectedIndices;
      const problems = selectedIndices.map((index) => allProblems[index]);
      const passCount = normalizePassCount(run.passCount);
      run.passCount = passCount;
      run.total = problems.length * passCount;
      syncRunCountsFromResults(run);
      run.activeTaskIds = [];
      run.activeTaskStartedAt = {};
      const completedAttemptIds = new Set(run.results.map(resultAttemptId).filter(Boolean));
      appendEvent(run, "run-started", {
        summary: runSummary(run, { includeResults: false }),
        datasetSize: allProblems.length,
        passCount
      });

      async function finishTask(result) {
        run.activeTaskIds = (run.activeTaskIds || []).filter((taskId) => taskId !== result.taskId);
        delete run.activeTaskStartedAt?.[result.taskId];
        run.currentTaskId = run.activeTaskIds[run.activeTaskIds.length - 1] || null;
        run.results.push(result);
        await appendTaskLogs(run, result);
        run.completed += 1;
        if (result.passed) run.passed += 1;
        else run.failed += 1;
        appendEvent(run, "task-finished", { result: compactResult(result), summary: runSummary(run, { includeResults: false }) });
      }

      async function runTask({ problem, index, ordinal, passNumber, passOrdinal, passTotal, attemptId }) {
        if (run.cancelled) throw new Error("Run cancelled.");
        const taskStartedAtMilliseconds = Date.now();
        run.activeTaskIds = [...new Set([...(run.activeTaskIds || []), problem.task_id])];
        run.activeTaskStartedAt = {
          ...(run.activeTaskStartedAt || {}),
          [problem.task_id]: new Date(taskStartedAtMilliseconds).toISOString()
        };
        run.currentTaskId = problem.task_id;
        const context = {
          attemptId,
          passNumber,
          passTotal,
          passOrdinal,
          ...(run.adaptiveRepetitionPenalty ? { repetitionPenalty: run.currentRepetitionPenalty } : {})
        };
        appendEvent(run, "task-started", {
          taskId: problem.task_id,
          index,
          ...context,
          ordinal,
          total: run.total,
          passTaskTotal: problems.length,
          entryPoint: problem.entry_point,
          subtask: problem.subtask,
          prompt: problem.prompt,
          test: benchmark.problemReference(problem),
          ...(problemImageRefs(benchmark, problem) ? { images: problemImageRefs(benchmark, problem) } : {}),
          summary: runSummary(run, { includeResults: false })
        });
        try {
          let generation;
          try {
            generation = await callModel(run, problem, index, context);
          } catch (error) {
            if (run.cancelled) throw error;
            if (error instanceof Error && error.name === "IncompleteModelResponseError") {
              appendEvent(run, "task-invalidated", {
                taskId: problem.task_id,
                index,
                ...context,
                reason: error.message,
                summary: runSummary(run, { includeResults: false })
              });
              throw error;
            }
            const result = {
              taskId: problem.task_id,
              attemptId,
              passNumber,
              passTotal,
              index,
              entryPoint: problem.entry_point,
              subtask: problem.subtask,
              passed: false,
              score: 0,
              answerScore: 0,
              modelError: error instanceof Error ? error.message : String(error),
              ...(problemImageRefs(benchmark, problem) ? { images: problemImageRefs(benchmark, problem) } : {}),
              tests: [],
              instructionPrompt: buildPromptMessages(problem, run.systemPrompt, run.promptTemplate).map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
              prompt: problem.prompt,
              test: benchmark.problemReference(problem),
              rawOutput: "",
              thinkingOutput: "",
              extractedCode: "",
              usage: null,
              finishReason: null,
              ...(run.adaptiveRepetitionPenalty ? { repetitionPenalty: context.repetitionPenalty } : {}),
              generationMs: Date.now() - taskStartedAtMilliseconds,
              activeDurationMilliseconds: Date.now() - taskStartedAtMilliseconds
            };
            await finishTask(result);
            return;
          }
          if (run.adaptiveRepetitionPenalty) {
            const testedRepetitionPenalties = run.results
              .filter((result) => Number.isFinite(result.repetitionPenalty) && !result.modelError)
              .map((result) => result.repetitionPenalty);
            const nextPenaltyState = nextAdaptiveRepetitionPenalty({
              repetitionPenalty: context.repetitionPenalty,
              knownLoopingPenalty: run.knownLoopingPenalty,
              testedRepetitionPenalties,
              looping: Boolean(generation.loopDetection)
            });
            run.currentRepetitionPenalty = nextPenaltyState.repetitionPenalty;
            run.knownLoopingPenalty = nextPenaltyState.knownLoopingPenalty;
            appendEvent(run, "repetition-penalty-updated", {
              taskId: problem.task_id,
              index,
              ...context,
              looping: Boolean(generation.loopDetection),
              nextRepetitionPenalty: run.currentRepetitionPenalty,
              knownLoopingPenalty: run.knownLoopingPenalty
            });
          }
          if (run.adaptiveRepetitionPenalty && generation.loopDetection) {
            const result = {
              taskId: problem.task_id,
              attemptId,
              passNumber,
              passTotal,
              index,
              entryPoint: problem.entry_point,
              subtask: problem.subtask,
              passed: false,
              score: 0,
              answerScore: 0,
              looping: true,
              loopDetection: generation.loopDetection,
              ...(run.adaptiveRepetitionPenalty ? { repetitionPenalty: context.repetitionPenalty } : {}),
              ...(problemImageRefs(benchmark, problem) ? { images: problemImageRefs(benchmark, problem) } : {}),
              tests: [],
              instructionPrompt: buildPromptMessages(problem, run.systemPrompt, run.promptTemplate).map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
              prompt: problem.prompt,
              test: benchmark.problemReference(problem),
              rawOutput: generation.output,
              thinkingOutput: generation.thinking,
              extractedCode: "",
              usage: generation.usage,
              finishReason: generation.finishReason,
              generationMs: generation.elapsedMs,
              activeDurationMilliseconds: Date.now() - taskStartedAtMilliseconds
            };
            await finishTask(result);
            return;
          }
          const extractedCode = benchmark.extractArtifact(generation.output, problem);
          appendEvent(run, "code-extracted", { taskId: problem.task_id, index, ...context, code: extractedCode });
          const evaluationStartedAtMilliseconds = Date.now();
          const testResult = await benchmark.evaluate({
            problem,
            artifact: extractedCode,
            rawOutput: generation.output,
            timeoutSeconds: run.timeoutSeconds
          });
          const evaluationDurationMilliseconds = Date.now() - evaluationStartedAtMilliseconds;
          const result = {
            taskId: problem.task_id,
            attemptId,
            passNumber,
            passTotal,
            index,
            entryPoint: problem.entry_point,
            subtask: problem.subtask,
            passed: Boolean(testResult.passed),
            // Graded benchmarks return a fractional [0,1] task score; binary
            // ones fall back to 1/0 from `passed` so summaries can always sum.
            score: normalizeTaskScore(testResult.score, testResult.passed),
            // Answer quality before confidence weighting; drives the
            // pass/partial/fail status so honest-but-wrong stays red.
            answerScore: normalizeTaskScore(testResult.answerScore ?? testResult.score, testResult.passed),
            ...(problemImageRefs(benchmark, problem) ? { images: problemImageRefs(benchmark, problem) } : {}),
            tests: testResult.tests || [],
            expectedAnswer: testResult.expectedAnswer,
            stdout: testResult.stdout || "",
            stderr: testResult.stderr || "",
            harnessStdout: testResult.harnessStdout || "",
            harnessStderr: testResult.harnessStderr || "",
            error: testResult.error || null,
            traceback: testResult.traceback || null,
            timeout: Boolean(testResult.timeout),
            instructionPrompt: buildPromptMessages(problem, run.systemPrompt, run.promptTemplate).map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n"),
            prompt: problem.prompt,
            test: benchmark.problemReference(problem),
            rawOutput: generation.output,
            thinkingOutput: generation.thinking,
            extractedCode,
            ...(generation.loopDetection ? { loopDetection: generation.loopDetection } : {}),
            usage: generation.usage,
            finishReason: generation.finishReason,
            ...(run.adaptiveRepetitionPenalty ? { repetitionPenalty: context.repetitionPenalty } : {}),
            generationMs: generation.elapsedMs,
            evaluationDurationMilliseconds,
            activeDurationMilliseconds: Date.now() - taskStartedAtMilliseconds
          };
          await finishTask(result);
        } finally {
          run.activeTaskIds = (run.activeTaskIds || []).filter((taskId) => taskId !== problem.task_id);
          delete run.activeTaskStartedAt?.[problem.task_id];
          run.currentTaskId = run.activeTaskIds[run.activeTaskIds.length - 1] || null;
        }
      }

      async function runWorker(tasks, getNextTaskIndex) {
        while (true) {
          if (run.cancelled) throw new Error("Run cancelled.");
          if (run.requestedStopMode === "after-task") return;
          const taskIndex = getNextTaskIndex();
          if (taskIndex >= tasks.length) return;
          await runTask(tasks[taskIndex]);
        }
      }

      for (let passNumber = 1; passNumber <= passCount; passNumber += 1) {
        if (run.cancelled) throw new Error("Run cancelled.");
        const tasks = problems.map((problem, i) => {
          const passOrdinal = i + 1;
          return {
            problem,
            index: selectedIndices[i],
            ordinal: (passNumber - 1) * problems.length + passOrdinal,
            passOrdinal,
            passNumber,
            passTotal: passCount,
            attemptId: `${problem.task_id}::pass-${passNumber}`
          };
        });
        const remainingTasks = tasks.filter((task) => !completedAttemptIds.has(task.attemptId));
        if (!remainingTasks.length) continue;
        const workerCount = Math.min(run.parallelTasks || 1, remainingTasks.length || 1);
        let nextTask = 0;
        const getNextTaskIndex = () => {
          const taskIndex = nextTask;
          nextTask += 1;
          return taskIndex;
        };
        await Promise.all(Array.from({ length: workerCount }, () => runWorker(remainingTasks, getNextTaskIndex)));
        if (run.requestedStopMode === "after-task" || run.requestedStopMode === "after-pass") {
          const requestedStopMode = run.requestedStopMode;
          run.cancelled = true;
          throw new Error(requestedStopMode === "after-task"
            ? "Run stopped after current task."
            : "Run stopped after current pass.");
        }
      }
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.activeTaskIds = [];
      run.activeTaskStartedAt = {};
      run.currentTaskId = null;
      appendEvent(run, "done", { summary: runSummary(run, { includeResults: false }) });
      logTerminalRunPerformance(run, run.status);
      persistRunArtifacts(run);
    } catch (error) {
      run.status = run.cancelled ? "cancelled" : "error";
      run.requestedStopMode = null;
      run.finishedAt = new Date().toISOString();
      run.activeTaskIds = [];
      run.activeTaskStartedAt = {};
      run.currentTaskId = null;
      appendEvent(run, "error", { message: error instanceof Error ? error.message : String(error), summary: runSummary(run, { includeResults: false }) });
      logTerminalRunPerformance(run, run.status);
      persistRunArtifacts(run);
    }
  }

  // Model capability lookup, oMLX-specific: the OpenAI-compatible /v1/models
  // reply has no vision flag, but oMLX's admin API exposes model_type
  // ("vlm" | "llm" | "embedding" | ...). Best effort — any failure returns
  // null (capability unknown) so non-oMLX endpoints keep working.
  async function fetchModelTypes(baseUrl, apiKey) {
    try {
      const origin = new URL(baseUrl).origin;
      const response = await fetchImplementation(`${origin}/admin/api/models`, {
        signal: AbortSignal.timeout(2000),
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload?.models)) return null;
      const types = new Map();
      for (const model of payload.models) {
        if (typeof model?.id === "string" && typeof model?.model_type === "string") {
          types.set(model.id, model.model_type);
        }
      }
      return types.size ? types : null;
    } catch {
      return null;
    }
  }

  async function fetchLmStudioModelInfo(baseUrl, modelId, apiKey) {
    try {
      const origin = new URL(baseUrl).origin;
      const response = await fetchImplementation(`${origin}/api/v1/models`, {
        signal: AbortSignal.timeout(2000),
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload?.models)) return null;
      const normalizedModelId = String(modelId || "").trim();
      return payload.models.find((modelInfo) => (
        modelInfo?.key === normalizedModelId
        || modelInfo?.loaded_instances?.some((instance) => instance?.id === normalizedModelId)
      )) ?? null;
    } catch {
      return null;
    }
  }

  async function usesLmStudioSdkForThinking(baseUrl, modelId, thinkingEnabled, apiKey, providerName) {
    if (!thinkingEnabled) return false;
    const namedLmStudioProvider = String(providerName || "").toLowerCase().includes("lm studio");
    const endpointUrl = new URL(baseUrl);
    if (!namedLmStudioProvider && (providerName || endpointUrl.port !== "1234")) return false;
    const modelInfo = await fetchLmStudioModelInfo(baseUrl, modelId, apiKey);
    if (!modelInfo) {
      if (!namedLmStudioProvider) return false;
      throw new Error(
        `Could not verify model "${modelId}" through LM Studio's model metadata API. `
        + "Make sure LM Studio is running, the model is loaded, and its server is up to date."
      );
    }
    if (modelInfo.format !== "gguf") {
      throw new Error(
        `Model "${modelId}" is loaded in LM Studio as ${modelInfo.format || "an unknown format"}. `
        + "Numeric reasoning budgets require a GGUF model on the llama.cpp runtime. "
        + "Load the GGUF variant or turn off thinking."
      );
    }
    return true;
  }

  // A text-only model does not error on image parts — oMLX silently drops
  // them and the model answers from the text alone ("we cannot see the
  // photo"), producing garbage scores that look like a completed run. Refuse
  // up front whenever the capability is knowable.
  async function assertModelCanSeeImages(baseUrl, modelId, benchmark, problems, apiKey) {
    if (!problems.some((problem) => Array.isArray(problem.images) && problem.images.length)) return;
    const modelTypes = await fetchModelTypes(baseUrl, apiKey);
    const modelType = modelTypes?.get(String(modelId || "").trim());
    if (modelType !== undefined && modelType !== "vlm") {
      throw new Error(
        `Model "${modelId}" is not a vision model (oMLX model_type "${modelType}") — `
        + `"${benchmark.label}" attaches photographs to every call, and a text-only model `
        + "silently ignores them, so every score would be garbage. Pick a model listed as "
        + 'model_type "vlm" (the model dropdown tags them "vision").'
      );
    }
  }

  async function assertVlmRunModelSupportsThinking(baseUrl, modelId, thinkingEnabled, apiKey) {
    if (!thinkingEnabled) return;
    const endpointUrl = new URL(baseUrl);
    if (endpointUrl.hostname !== "gateway.vlm.run") return;
    try {
      const modelDetailsUrl = new URL(`/v1/models/${encodeURIComponent(String(modelId || "").trim())}`, endpointUrl.origin);
      const response = await fetchImplementation(modelDetailsUrl, {
        signal: AbortSignal.timeout(3000),
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!Array.isArray(payload?.supported_parameters)) return;
      const thinkingParameters = new Set([
        "enable_thinking",
        "reasoning_effort",
        "thinking_budget",
        "chat_template_kwargs"
      ]);
      if (payload.supported_parameters.some((parameter) => thinkingParameters.has(parameter))) return;
      throw new Error(
        `Model "${modelId}" on gateway.vlm.run does not support thinking. Its live model metadata lists `
        + `only: ${payload.supported_parameters.join(", ") || "no request parameters"}. `
        + "Turn off thinking or use an endpoint that supports enable_thinking."
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not support thinking")) throw error;
    }
  }

  async function resolveProviderConfig(config, run = null) {
    const providerId = String(config.providerId ?? run?.providerId ?? "").trim();
    if (!providerId) {
      return {
        providerId: null,
        providerName: null,
        baseUrl: normalizeBaseUrl(config.baseUrl ?? run?.baseUrl),
        apiKey: String(config.apiKey ?? run?.apiKey ?? "").trim()
      };
    }
    const provider = await providerStore.resolve(providerId);
    return {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey
    };
  }

  async function createRun(config) {
    const { baseUrl, apiKey, providerId, providerName } = await resolveProviderConfig(config);
    const benchmark = getBenchmark(config.benchmark);
    const allProblems = await loadBenchmarkProblems(benchmark);
    await assertModelCanSeeImages(baseUrl, config.model, benchmark, allProblems, apiKey);
    await assertVlmRunModelSupportsThinking(
      baseUrl,
      config.model,
      config.thinkingEnabled !== false,
      apiKey
    );
    const usesLmStudioSdk = await usesLmStudioSdkForThinking(
      baseUrl,
      config.model,
      config.thinkingEnabled !== false,
      apiKey,
      providerName
    );
    const selectedIndices = parseTestNumbers(config.testNumbers, allProblems.length, benchmark.taskIdPattern);
    const adaptiveRepetitionPenalty = Boolean(config.adaptiveRepetitionPenalty);
    const repetitionPenalty = Number(config.repetitionPenalty ?? 1);
    if (adaptiveRepetitionPenalty && (!Number.isFinite(repetitionPenalty) || repetitionPenalty <= 0)) {
      throw new Error("Starting repetition penalty must be greater than zero.");
    }
    const parallelTasks = adaptiveRepetitionPenalty ? 1 : normalizeParallelTasks(config.parallelTasks);
    const passCount = normalizePassCount(config.passCount);
    const startIndex = normalizeTaskCount(config.startIndex);
    const sampleLimit = normalizeTaskCount(config.sampleLimit);
    const plannedTaskCount = selectedIndices.length || (() => {
      const end = sampleLimit > 0 ? Math.min(allProblems.length, startIndex + sampleLimit) : allProblems.length;
      return Math.max(0, end - startIndex);
    })();
    const id = `${benchmark.id === "humaneval" ? "he" : benchmark.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const run = {
      id,
      dir: null,
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
      benchmark: benchmark.id,
      benchmarkDataRevision: benchmark.dataRevision || null,
      model: String(config.model || "").trim(),
      providerId,
      providerName,
      baseUrl,
      apiKey,
      usesLmStudioSdk,
      temperature: Number(config.temperature ?? 0),
      maxOutputTokens: normalizeTokenCount(config.maxOutputTokens, 2048),
      thinkingEnabled: config.thinkingEnabled !== false,
      thinkingBudget: normalizeTokenCount(config.thinkingBudget, 8192),
      timeoutSeconds: Number(config.timeoutSeconds ?? 15),
      parallelTasks,
      passCount,
      sampleLimit,
      startIndex,
      selectedIndices,
      systemPrompt: String(config.systemPrompt ?? benchmark.defaultSystemPrompt),
      promptTemplate: String(config.promptTemplate ?? benchmark.defaultPromptTemplate),
      extraBody: config.extraBody && typeof config.extraBody === "object" ? config.extraBody : {},
      adaptiveRepetitionPenalty,
      repetitionPenalty,
      currentRepetitionPenalty: initialRepetitionPenalty(repetitionPenalty, config.extraBody),
      knownLoopingPenalty: null,
      publicConfig: {
        providerId,
        providerName,
        baseUrl,
        benchmark: benchmark.id,
        model: String(config.model || "").trim(),
        temperature: Number(config.temperature ?? 0),
        maxOutputTokens: normalizeTokenCount(config.maxOutputTokens, 2048),
        thinkingEnabled: config.thinkingEnabled !== false,
        thinkingBudget: normalizeTokenCount(config.thinkingBudget, 8192),
        timeoutSeconds: Number(config.timeoutSeconds ?? 15),
        parallelTasks,
        passCount,
        apiKey: redactApiKey(apiKey, baseUrl),
        sampleLimit,
        startIndex,
        testNumbers: String(config.testNumbers || ""),
        systemPrompt: String(config.systemPrompt ?? benchmark.defaultSystemPrompt),
        promptTemplate: String(config.promptTemplate ?? benchmark.defaultPromptTemplate),
        extraBody: config.extraBody && typeof config.extraBody === "object" ? config.extraBody : {},
        adaptiveRepetitionPenalty,
        repetitionPenalty,
        loopDetectionConfig: LOOP_DETECTION_CONFIG
      },
      total: plannedTaskCount * passCount,
      completed: 0,
      passed: 0,
      failed: 0,
      currentTaskId: null,
      activeTaskIds: [],
      activeTaskStartedAt: {},
      results: [],
      events: [],
      eventSeq: 0,
      clients: new Set(),
      cancelled: false,
      requestedStopMode: null,
      abortController: null,
      abortControllers: new Set()
    };
    if (!run.model) throw new Error("Model name is required.");
    runs.set(id, run);
    enqueueRun(run);
    return run;
  }

  function runCanResume(run) {
    if (run.deleted) return false;
    if (run.status === "running" || run.status === "queued") return false;
    if (run.status === "completed" && !runHasModelErrorResults(run)) return false;
    return run.completed < run.total || runHasModelErrorResults(run);
  }

  async function applyResumeConfig(run, config) {
    const benchmark = getBenchmark(config.benchmark ?? run.benchmark);
    const allProblems = await loadBenchmarkProblems(benchmark);
    const { baseUrl, apiKey, providerId, providerName } = await resolveProviderConfig(config, run);
    const adaptiveRepetitionPenalty = config.adaptiveRepetitionPenalty === undefined
      ? run.adaptiveRepetitionPenalty
      : Boolean(config.adaptiveRepetitionPenalty);
    const repetitionPenalty = Number(config.repetitionPenalty ?? run.repetitionPenalty ?? 1);
    if (adaptiveRepetitionPenalty && (!Number.isFinite(repetitionPenalty) || repetitionPenalty <= 0)) {
      throw new Error("Starting repetition penalty must be greater than zero.");
    }
    const parallelTasks = adaptiveRepetitionPenalty
      ? 1
      : normalizeParallelTasks(config.parallelTasks ?? run.parallelTasks);
    const passCount = normalizePassCount(config.passCount ?? run.passCount);
    const sampleLimit = normalizeTaskCount(config.sampleLimit ?? run.sampleLimit);
    const startIndex = normalizeTaskCount(config.startIndex ?? run.startIndex);
    const testNumbers = String(config.testNumbers ?? run.publicConfig?.testNumbers ?? "");
    const selectedIndices = parseTestNumbers(testNumbers, allProblems.length, benchmark.taskIdPattern);
    const effectiveSelectedIndices = selectedIndices.length
      ? selectedIndices
      : (() => {
          const end = sampleLimit > 0 ? Math.min(allProblems.length, startIndex + sampleLimit) : allProblems.length;
          return Array.from({ length: Math.max(0, end - startIndex) }, (_, offset) => startIndex + offset);
        })();
    const benchmarkChanged = benchmark.id !== run.benchmark;
    const selectedIndexSet = new Set(effectiveSelectedIndices);
    run.results = benchmarkChanged
      ? []
      : run.results.filter((result) => selectedIndexSet.has(result.index) && Number(result.passNumber || 1) <= passCount);
    run.benchmark = benchmark.id;
    if (benchmarkChanged) run.benchmarkDataRevision = benchmark.dataRevision || null;
    run.baseUrl = baseUrl;
    run.apiKey = apiKey;
    run.providerId = providerId;
    run.providerName = providerName;
    run.model = String(config.model ?? run.model ?? "").trim();
    run.temperature = Number(config.temperature ?? run.temperature ?? 0);
    run.maxOutputTokens = normalizeTokenCount(config.maxOutputTokens ?? run.maxOutputTokens, 2048);
    run.thinkingEnabled = config.thinkingEnabled ?? run.thinkingEnabled;
    run.thinkingBudget = normalizeTokenCount(config.thinkingBudget ?? run.thinkingBudget, 8192);
    run.timeoutSeconds = Number(config.timeoutSeconds ?? run.timeoutSeconds ?? 15);
    run.parallelTasks = parallelTasks;
    run.passCount = passCount;
    run.sampleLimit = sampleLimit;
    run.startIndex = startIndex;
    run.selectedIndices = effectiveSelectedIndices;
    run.systemPrompt = String(config.systemPrompt ?? run.systemPrompt ?? benchmark.defaultSystemPrompt);
    run.promptTemplate = String(config.promptTemplate ?? run.promptTemplate ?? benchmark.defaultPromptTemplate);
    run.extraBody = config.extraBody && typeof config.extraBody === "object" ? config.extraBody : run.extraBody;
    run.adaptiveRepetitionPenalty = adaptiveRepetitionPenalty;
    run.repetitionPenalty = repetitionPenalty;
    if (
      Object.hasOwn(config, "adaptiveRepetitionPenalty")
      || Object.hasOwn(config, "repetitionPenalty")
      || Object.hasOwn(config, "extraBody")
    ) {
      run.currentRepetitionPenalty = initialRepetitionPenalty(repetitionPenalty, run.extraBody);
      run.knownLoopingPenalty = null;
    }
    run.total = effectiveSelectedIndices.length * passCount;
    run.publicConfig = {
      providerId,
      providerName,
      baseUrl,
      benchmark: benchmark.id,
      model: run.model,
      temperature: run.temperature,
      maxOutputTokens: run.maxOutputTokens,
      thinkingEnabled: run.thinkingEnabled,
      thinkingBudget: run.thinkingBudget,
      timeoutSeconds: run.timeoutSeconds,
      parallelTasks,
      passCount,
      apiKey: redactApiKey(apiKey, baseUrl),
      sampleLimit,
      startIndex,
      testNumbers,
      systemPrompt: run.systemPrompt,
      promptTemplate: run.promptTemplate,
      extraBody: run.extraBody,
      adaptiveRepetitionPenalty,
      repetitionPenalty,
      loopDetectionConfig: LOOP_DETECTION_CONFIG
    };
    syncRunCountsFromResults(run);
    if (!run.model) throw new Error("Model name is required.");
  }

  // Async pre-checks for resume, separated so resumeRun itself stays
  // synchronous: the resume response must serialize the "queued" state before
  // the runBenchmark microtask flips it to "running".
  async function assertRunResumable(run) {
    const benchmark = getBenchmark(run.benchmark);
    const problems = await loadBenchmarkProblems(benchmark);
    await assertModelCanSeeImages(run.baseUrl, run.model, benchmark, problems, run.apiKey);
    run.usesLmStudioSdk = await usesLmStudioSdkForThinking(
      run.baseUrl,
      run.model,
      run.thinkingEnabled,
      run.apiKey,
      run.providerName
    );
  }

  function resumeRun(run) {
    syncRunCountsFromResults(run);
    if (!runCanResume(run)) {
      throw new Error("Run cannot be resumed.");
    }
    const benchmark = getBenchmark(run.benchmark);
    const currentBenchmarkDataRevision = benchmark.dataRevision || null;
    const runBenchmarkDataRevision = run.benchmarkDataRevision || null;
    if (runBenchmarkDataRevision !== currentBenchmarkDataRevision) {
      throw new Error(
        `Run uses benchmark data revision "${runBenchmarkDataRevision || "unversioned"}", `
        + `but the current revision is "${currentBenchmarkDataRevision || "unversioned"}". Start a new run instead.`
      );
    }
    run.cancelled = false;
    run.requestedStopMode = null;
    run.finishedAt = null;
    run.activeTaskIds = [];
    run.activeTaskStartedAt = {};
    run.currentTaskId = null;
    run.abortController = null;
    run.abortControllers = new Set();
    discardResumeArtifacts(run);
    return enqueueRun(run);
  }

  async function loadPersistedRuns() {
    await fs.mkdir(runsDir, { recursive: true });
    const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // Migration backups live beneath the runs directory but are not runs.
      // Ignore all hidden directories so they are not treated as persisted runs.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(runsDir, entry.name);
      try {
        const raw = await fs.readFile(join(dir, "run.json"), "utf8");
        const persisted = JSON.parse(raw);
        const resultsRaw = await fs.readFile(join(dir, "results.json"), "utf8").catch(() => "[]");
        const results = JSON.parse(resultsRaw);
        const persistedRuntimeConfig = runtimeConfigFromPersistedRun(persisted);
        if (persistedRuntimeConfig.providerId) {
          try {
            const provider = await providerStore.resolve(persistedRuntimeConfig.providerId);
            persistedRuntimeConfig.providerName = provider.name;
            persistedRuntimeConfig.baseUrl = provider.baseUrl;
            persistedRuntimeConfig.apiKey = provider.apiKey;
          } catch (error) {
            // Keep the run visible even when its provider was removed. Resume
            // will explain that the saved provider must be recreated/selected.
            persistedRuntimeConfig.apiKey = "";
            persistedRuntimeConfig.providerError = error instanceof Error ? error.message : String(error);
          }
        }
        const run = {
          ...persisted,
          ...persistedRuntimeConfig,
          dir,
          // The queue does not survive a restart; a persisted position is stale.
          queuePosition: null,
          activeTaskIds: [],
          activeTaskStartedAt: {},
          events: [],
          eventSeq: 0,
          results: Array.isArray(results) ? results : [],
          clients: new Set(),
          cancelled: persisted.status === "cancelled",
          abortController: null,
          abortControllers: new Set()
        };
        if (run.adaptiveRepetitionPenalty) {
          const penaltyState = restoreAdaptiveRepetitionPenaltyState(
            run.results,
            run.repetitionPenalty,
            run.extraBody
          );
          run.currentRepetitionPenalty = penaltyState.repetitionPenalty;
          run.knownLoopingPenalty = penaltyState.knownLoopingPenalty;
        }
        syncRunCountsFromResults(run);
        if (run.status === "running" || run.status === "queued") {
          run.status = "interrupted";
          run.finishedAt = run.finishedAt || new Date().toISOString();
        }
        runs.set(run.id, run);
      } catch (error) {
        console.error(`Failed to load persisted run from ${dir}:`, error);
      }
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return sendJson(res, 200, {});
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/api/benchmarks") {
        return sendJson(res, 200, { benchmarks: benchmarkSummaries() });
      }
      if (req.method === "GET" && url.pathname === "/api/providers") {
        return sendJson(res, 200, { providers: await providerStore.list() });
      }
      if (req.method === "POST" && url.pathname === "/api/providers") {
        try {
          const provider = await providerStore.save(await readJsonBody(req));
          return sendJson(res, 201, { provider });
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (providerMatch && req.method === "PUT") {
        try {
          const provider = await providerStore.save(
            await readJsonBody(req),
            decodeURIComponent(providerMatch[1])
          );
          return sendJson(res, 200, { provider });
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (providerMatch && req.method === "DELETE") {
        try {
          const removed = await providerStore.remove(decodeURIComponent(providerMatch[1]));
          return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Provider not found." });
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // Serve benchmark-owned binary assets (e.g. dataset photographs) so the
      // UI can show exactly what was sent to the model. The benchmark decides
      // which names are legal and where they live; anything it declines is a
      // 404, so no other file on disk is reachable through this route.
      if (req.method === "GET" && url.pathname.startsWith(BENCHMARK_ASSET_ROUTE_PREFIX)) {
        const [rawBenchmarkId, ...rest] = url.pathname.slice(BENCHMARK_ASSET_ROUTE_PREFIX.length).split("/");
        const benchmarkId = decodeURIComponent(rawBenchmarkId || "");
        const file = decodeURIComponent(rest.join("/"));
        const contentType = ASSET_CONTENT_TYPES.get(file.split(".").pop()?.toLowerCase() || "");
        if (!contentType) return sendJson(res, 400, { error: "unsupported asset type" });
        const assetPath = benchmarks.get(benchmarkId)?.resolveAssetPath?.(file) ?? null;
        if (!assetPath) return sendJson(res, 404, { error: "asset not found" });
        try {
          const bytes = await fs.readFile(assetPath);
          res.writeHead(200, {
            "content-type": contentType,
            "content-length": String(bytes.length),
            "access-control-allow-origin": "*",
            // Not immutable: a re-export can rewrite the bytes behind a name.
            "cache-control": "public, max-age=300"
          });
          return res.end(bytes);
        } catch {
          return sendJson(res, 404, { error: "asset not found" });
        }
      }
      // Proxy the endpoint's model list so the UI can offer autocomplete
      // without a cross-origin call. NOTE: OpenAI-compatible /models replies
      // (oMLX included) expose no vision-capability flag, so the UI cannot
      // pre-filter models for image benchmarks — a non-vision model simply
      // fails the run with the server's own error.
      if (req.method === "GET" && url.pathname === "/api/models") {
        const providerId = url.searchParams.get("providerId") || "";
        let baseUrl;
        let apiKey;
        try {
          if (providerId) {
            const provider = await providerStore.resolve(providerId);
            baseUrl = provider.baseUrl;
            apiKey = provider.apiKey;
          } else {
            const rawBaseUrl = url.searchParams.get("baseUrl") || "";
            if (!rawBaseUrl.trim()) {
              return sendJson(res, 400, { error: "providerId query parameter is required" });
            }
            baseUrl = normalizeBaseUrl(rawBaseUrl);
            apiKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
          }
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : "Provider is not valid." });
        }
        try {
          const upstream = await fetchImplementation(`${baseUrl}/models`, {
            signal: AbortSignal.timeout(3000),
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}
          });
          if (!upstream.ok) {
            return sendJson(res, 502, { error: `Model endpoint replied HTTP ${upstream.status}` });
          }
          const payload = await upstream.json();
          // modelType comes from oMLX's admin API ("vlm" = vision-capable);
          // null when the endpoint exposes no capability data.
          const modelTypes = await fetchModelTypes(baseUrl, apiKey);
          const models = Array.isArray(payload?.data)
            ? payload.data
                .filter((model) => typeof model?.id === "string")
                .map((model) => ({
                  id: model.id,
                  maxModelLen: model.max_model_len ?? null,
                  modelType: modelTypes?.get(model.id) ?? null
                }))
            : [];
          return sendJson(res, 200, { models });
        } catch (error) {
          return sendJson(res, 502, {
            error: `Could not list models: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
      const problemsMatch = url.pathname === "/api/problems"
        ? ["", "humaneval"]
        : url.pathname.match(/^\/api\/benchmarks\/([^/]+)\/problems$/);
      if (req.method === "GET" && problemsMatch) {
        const benchmark = getBenchmark(problemsMatch[1]);
        const problems = await loadBenchmarkProblems(benchmark);
        return sendJson(res, 200, {
          benchmark: benchmark.id,
          total: problems.length,
          problems: problems.map((problem) => benchmark.problemSummary(problem))
        });
      }
      if (req.method === "GET" && url.pathname === "/api/runs") {
        const summaries = [...runs.values()]
          .map((run) => runSummary(run, { includeResults: false }))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return sendJson(res, 200, { runs: summaries }, { endpoint: "list-runs", runCount: summaries.length });
      }
      if (req.method === "POST" && url.pathname === "/api/runs") {
        const body = await readJsonBody(req);
        const run = await createRun(body);
        return sendJson(res, 201, runSummary(run), { endpoint: "create-run", runId: run.id, resultCount: run.results.length });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(events|cancel|stop|resume))?$/);
      if (runMatch) {
        const run = runs.get(runMatch[1]);
        if (!run) return sendJson(res, 404, { error: "Run not found" });
        if (req.method === "DELETE" && !runMatch[2]) {
          run.deleted = true;
          run.cancelled = true;
          dequeueRun(run);
          for (const controller of run.abortControllers || []) controller.abort();
          run.abortController?.abort();
          for (const client of run.clients) client.end();
          run.clients.clear();
          runs.delete(run.id);
          taskLogWriteQueues.delete(run.id);
          runPersistStates.delete(run.id);
          if (run.dir) await fs.rm(run.dir, { recursive: true, force: true });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "GET" && !runMatch[2]) {
          return sendJson(res, 200, { ...runSummary(run), events: run.events }, {
            endpoint: "get-run",
            runId: run.id,
            resultCount: run.results.length,
            eventCount: run.events.length
          });
        }
        if (req.method === "POST" && runMatch[2] === "stop") {
          const requestedStopMode = url.searchParams.get("mode");
          if (!["after-task", "after-pass"].includes(requestedStopMode)) {
            return sendJson(res, 400, { error: "Unknown stop mode." });
          }
          if (run.status !== "running") {
            return sendJson(res, 409, { error: "Only a running run can stop gracefully." });
          }
          run.requestedStopMode = requestedStopMode;
          appendEvent(run, "stop-requested", {
            mode: requestedStopMode,
            summary: runSummary(run, { includeResults: false })
          });
          return sendJson(res, 200, runSummary(run, { includeResults: false }));
        }
        if (req.method === "DELETE" && runMatch[2] === "stop") {
          if (run.status !== "running" || !run.requestedStopMode) {
            return sendJson(res, 409, { error: "Run has no pending stop request." });
          }
          run.requestedStopMode = null;
          appendEvent(run, "stop-cancelled", {
            summary: runSummary(run, { includeResults: false })
          });
          return sendJson(res, 200, runSummary(run, { includeResults: false }));
        }
        if (req.method === "POST" && runMatch[2] === "cancel") {
          run.cancelled = true;
          if (run.status === "queued") {
            // Cancelling a waiting run just takes it out of line; runs behind
            // it move up. The aborts below cover the already-started case.
            dequeueRun(run);
            run.status = "cancelled";
            run.finishedAt = new Date().toISOString();
            appendEvent(run, "error", { message: "Run cancelled.", summary: runSummary(run, { includeResults: false }) });
          }
          for (const controller of run.abortControllers || []) controller.abort();
          run.abortController?.abort();
          return sendJson(res, 200, runSummary(run, { includeResults: false }));
        }
        if (req.method === "POST" && runMatch[2] === "resume") {
          const body = await readJsonBody(req);
          await applyResumeConfig(run, body);
          await assertRunResumable(run);
          const resumedRun = resumeRun(run);
          return sendJson(res, 200, runSummary(resumedRun, { includeResults: false }));
        }
        if (req.method === "GET" && runMatch[2] === "events") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*"
          });
          for (const event of run.events) {
            res.write(`id: ${event.id}\n`);
            res.write(`event: ${event.type}\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          run.clients.add(res);
          req.on("close", () => run.clients.delete(res));
          return;
        }
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        console.error("Request failed after response headers were sent:", error);
        res.end();
      }
    }
  });

  return { server, runs, port, runsDir, cacheDir, configDir, providerStore, loadPersistedRuns };
}

export async function startRuntimeServer(options = {}) {
  const app = createRuntimeServer(options);
  await app.loadPersistedRuns();
  await new Promise((resolve) => app.server.listen(app.port, "0.0.0.0", resolve));
  console.log(`Eval benchmark server listening on http://localhost:${app.port}`);
  console.log(`Benchmark artifacts are written to ${app.runsDir}`);
  return app;
}
