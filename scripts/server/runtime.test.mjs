// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bbehDataRevision } from "./benchmarks/bbehDataCorrections.mjs";
import { createRuntimeTestHarness } from "./runtimeTestHarness.mjs";

const problems = [
  {
    task_id: "HumanEval/0",
    prompt: "def add_one(x):\n    \"\"\"Add one.\"\"\"\n",
    entry_point: "add_one",
    canonical_solution: "    return x + 1\n",
    test: "def check(candidate):\n    assert candidate(1) == 2\n    assert candidate(2) == 3\n"
  },
  {
    task_id: "HumanEval/1",
    prompt: "def double(x):\n    \"\"\"Double.\"\"\"\n",
    entry_point: "double",
    canonical_solution: "    return x * 2\n",
    test: "def check(candidate):\n    assert candidate(2) == 4\n"
  },
  {
    task_id: "HumanEval/2",
    prompt: "def negate(x):\n    \"\"\"Negate.\"\"\"\n",
    entry_point: "negate",
    canonical_solution: "    return -x\n",
    test: "def check(candidate):\n    assert candidate(2) == -2\n"
  }
];

const goodSolutions = {
  add_one: "def add_one(x):\n    return x + 1",
  double: "def double(x):\n    return x * 2",
  negate: "def negate(x):\n    return -x"
};

const harness = createRuntimeTestHarness();

afterEach(() => harness.cleanup());

async function makeRootDir() {
  const rootDir = await harness.makeRootDir("he-runtime-");
  await fs.writeFile(
    join(rootDir, ".cache", "HumanEval.jsonl"),
    problems.map((problem) => JSON.stringify(problem)).join("\n")
  );
  return rootDir;
}

function sseFrames(res, texts, { entryPoint }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `thinking about ${entryPoint}` } }] })}\n\n`);
  for (const text of texts) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 7 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function entryPointFromRequest(body) {
  const userMessage = body.messages.find((message) => message.role === "user")?.content || "";
  const match = userMessage.match(/def (\w+)\(/);
  return match ? match[1] : null;
}

function goodModelHandler(req, res, body) {
  const entryPoint = entryPointFromRequest(body);
  const code = goodSolutions[entryPoint] || "pass";
  sseFrames(res, ["```python\n", `${code}\n`, "```"], { entryPoint });
}

function nonStreamingGoodModelHandler(req, res, body) {
  const entryPoint = entryPointFromRequest(body);
  const code = goodSolutions[entryPoint] || "pass";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    choices: [{
      delta: { role: "assistant" },
      message: { content: `\`\`\`python\n${code}\n\`\`\`` },
      finish_reason: "stop"
    }],
    usage: { completion_tokens: 7 }
  }));
}

function finalUndelimitedSseGoodModelHandler(req, res, body) {
  const entryPoint = entryPointFromRequest(body);
  const code = goodSolutions[entryPoint] || "pass";
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
  res.end(`data: ${JSON.stringify({
    choices: [{ delta: { content: `\`\`\`python\n${code}\n\`\`\`` }, finish_reason: "stop" }],
    usage: { completion_tokens: 7 }
  })}`);
}

function loopingModelHandler(req, res) {
  const repeatedCycle = [
    "Reconsider every available choice and compare each stated condition before selecting the final answer",
    "the first condition supports one option while the second condition rules that same option out",
    "therefore the unresolved comparison begins again from the start"
  ].join(". ");
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (let repetitionIndex = 0; repetitionIndex < 5; repetitionIndex += 1) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${repeatedCycle}. ` } }] })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function loopingThenGoodModelHandler(req, res, body) {
  const repeatedCycle = [
    "Reconsider every available choice and compare each stated condition before selecting the final answer",
    "the first condition supports one option while the second condition rules that same option out",
    "therefore the unresolved comparison begins again from the start"
  ].join(". ");
  const entryPoint = entryPointFromRequest(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (let repetitionIndex = 0; repetitionIndex < 5; repetitionIndex += 1) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `${repeatedCycle}. ` } }] })}\n\n`);
  }
  for (const text of ["```python\n", `${goodSolutions[entryPoint]}\n`, "```"]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const { createRun, startModelServer, startRuntime, waitForStatus } = harness;

// Streams one token, then hangs until the client aborts, so a run stays
// "running" for as long as a test needs an occupied execution slot.
function makeHangingModelHandler(hangingResponses) {
  return (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
    hangingResponses.push(res);
    req.on("close", () => res.end());
  };
}

describe("runtime server", () => {
  it("proxies the endpoint's model list through /api/models", async () => {
    const rootDir = await makeRootDir();
    const { apiUrl } = await startRuntime(rootDir, {
      fetchImplementation: async (url) => {
        // The proxy fetches /v1/models and best-effort probes the oMLX admin
        // API for model types; this endpoint has no admin API.
        if (String(url) === "http://models.test/v1/models") {
          return new Response(
            JSON.stringify({ data: [{ id: "text-model", max_model_len: 4096 }, { id: "vl-model" }] })
          );
        }
        return new Response("not found", { status: 404 });
      }
    });

    const payload = await fetch(`${apiUrl}/api/models?baseUrl=http://models.test/v1/`)
      .then((response) => response.json());
    expect(payload).toEqual({
      models: [
        { id: "text-model", maxModelLen: 4096, modelType: null },
        { id: "vl-model", maxModelLen: null, modelType: null }
      ]
    });

    const missing = await fetch(`${apiUrl}/api/models`);
    expect(missing.status).toBe(400);
  });

  it("forwards the Authorization header to the upstream endpoint and its admin API", async () => {
    const rootDir = await makeRootDir();
    const seenAuthorizationHeaders = [];
    const { apiUrl } = await startRuntime(rootDir, {
      fetchImplementation: async (url, options) => {
        seenAuthorizationHeaders.push([String(url), options?.headers?.authorization]);
        if (String(url) === "http://models.test/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "text-model" }] }));
        }
        return new Response("not found", { status: 404 });
      }
    });

    await fetch(`${apiUrl}/api/models?baseUrl=http://models.test/v1/`, {
      headers: { authorization: "Bearer sk-live-secret" }
    }).then((response) => response.json());

    expect(seenAuthorizationHeaders).toContainEqual(["http://models.test/v1/models", "Bearer sk-live-secret"]);
    expect(seenAuthorizationHeaders).toContainEqual(["http://models.test/admin/api/models", "Bearer sk-live-secret"]);
  });

  it("resolves model lookup credentials from a saved provider", async () => {
    const rootDir = await makeRootDir();
    const seenAuthorizationHeaders = [];
    const providerStore = {
      resolve: vi.fn(async () => ({
        id: "openai-main",
        name: "OpenAI main",
        baseUrl: "https://models.test/v1",
        apiKey: "sk-from-vault"
      })),
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn()
    };
    const { apiUrl } = await startRuntime(rootDir, {
      providerStore,
      fetchImplementation: async (url, options) => {
        seenAuthorizationHeaders.push([String(url), options?.headers?.authorization]);
        if (String(url) === "https://models.test/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "vault-model" }] }));
        }
        return new Response("not found", { status: 404 });
      }
    });

    const payload = await fetch(`${apiUrl}/api/models?providerId=openai-main`).then((response) => response.json());

    expect(payload.models[0].id).toBe("vault-model");
    expect(providerStore.resolve).toHaveBeenCalledWith("openai-main");
    expect(seenAuthorizationHeaders).toContainEqual(["https://models.test/v1/models", "Bearer sk-from-vault"]);
  });

  it("rejects a non-positive adaptive starting penalty", async () => {
    const rootDir = await makeRootDir();
    const { apiUrl } = await startRuntime(rootDir);

    const response = await fetch(`${apiUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://model.test/v1",
        model: "test-model",
        adaptiveRepetitionPenalty: true,
        repetitionPenalty: 0
      })
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Starting repetition penalty must be greater than zero."
    });
  });

  it("rejects thinking when VLM Run model metadata says it is unsupported", async () => {
    const rootDir = await makeRootDir();
    const { apiUrl } = await startRuntime(rootDir, {
      fetchImplementation: async (url) => {
        if (String(url) === "https://gateway.vlm.run/v1/models/qwen%2Fqwen3.5-0.8b") {
          return new Response(JSON.stringify({
            supported_parameters: ["temperature", "top_p", "max_tokens", "response_format", "stop"]
          }));
        }
        return new Response("not found", { status: 404 });
      }
    });

    const response = await fetch(`${apiUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://gateway.vlm.run/v1/openai",
        model: "qwen/qwen3.5-0.8b",
        thinkingEnabled: true,
        testNumbers: "0"
      })
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Model \"qwen/qwen3.5-0.8b\" on gateway.vlm.run does not support thinking. Its live model metadata lists only: temperature, top_p, max_tokens, response_format, stop. Turn off thinking or use an endpoint that supports enable_thinking."
    });
  });

  it("stops loops and adapts repetition penalties across tasks", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([loopingModelHandler, goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      parallelTasks: 8,
      testNumbers: "0-1"
    });
    expect(created.config).toMatchObject({
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      parallelTasks: 1,
      loopDetectionConfig: { version: "4", repetitionCount: 5 }
    });

    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail.results[0]).toMatchObject({
      taskId: "HumanEval/0",
      passed: false,
      looping: true,
      repetitionPenalty: 0.5,
      finishReason: "loop",
      loopDetection: { channel: "thinking", repetitions: 5 }
    });
    expect(detail.results[1]).toMatchObject({
      taskId: "HumanEval/1",
      passed: true,
      repetitionPenalty: 0.55
    });
    expect(model.requests.map((request) => request.body.repetition_penalty)).toEqual([0.5, 0.55]);

    const penaltyEvents = detail.events.filter((event) => event.type === "repetition-penalty-updated");
    expect(penaltyEvents.map((event) => event.data.nextRepetitionPenalty)).toEqual([0.55, 0.52]);
    expect(detail.events.some((event) => event.type === "loop-detected")).toBe(true);
  });

  it("detects loops without stopping generation when adaptive mode is disabled", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([loopingThenGoodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: false,
      testNumbers: "0"
    });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);

    expect(detail.results[0]).toMatchObject({
      taskId: "HumanEval/0",
      passed: true,
      finishReason: "stop",
      loopDetection: { channel: "thinking", repetitions: 5 }
    });
    expect(detail.results[0]).not.toHaveProperty("looping");
    expect(detail.results[0].tests).toHaveLength(2);
    expect(detail.results[0].tests.every((test) => test.passed)).toBe(true);
    expect(detail.results[0].repetitionPenalty).toBeUndefined();
    expect(detail.events.some((event) => event.type === "loop-detected")).toBe(true);
    expect(detail.events.some((event) => event.type === "repetition-penalty-updated")).toBe(false);
  });

  it("completes a full run: scores, events, artifacts, task logs, SSE replay", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const problemsResponse = await fetch(`${apiUrl}/api/problems`).then((response) => response.json());
    expect(problemsResponse.total).toBe(3);
    expect(problemsResponse.problems[0]).toEqual({ taskId: "HumanEval/0", entryPoint: "add_one" });

    const created = await createRun(apiUrl, model.baseUrl, {
      apiKey: "sk-secret",
      testNumbers: "0-1",
      extraBody: { repetition_penalty: 0 }
    });
    expect(["queued", "running"]).toContain(created.status);
    expect(created.total).toBe(2);

    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({
      completed: 2,
      passed: 2,
      failed: 0,
      liveScore: 1,
      finalScore: 1,
      assertionsPassed: 3,
      assertionsTotal: 3
    });
    expect(detail.results.map((result) => result.taskId)).toEqual(["HumanEval/0", "HumanEval/1"]);
    expect(detail.results[0]).toMatchObject({
      attemptId: "HumanEval/0::pass-1",
      passed: true,
      entryPoint: "add_one",
      extractedCode: goodSolutions.add_one,
      thinkingOutput: "thinking about add_one",
      finishReason: "stop",
      usage: { completion_tokens: 7 }
    });
    expect(detail.results[0].tests).toHaveLength(2);
    expect(detail.results[0].instructionPrompt).toContain("SYSTEM:");

    const eventTypes = detail.events.map((event) => event.type);
    for (const expected of ["run-started", "task-started", "prompt", "token", "code-extracted", "task-finished", "done"]) {
      expect(eventTypes).toContain(expected);
    }

    // Model requests carry auth + streaming options.
    expect(model.requests[0].url).toBe("/v1/chat/completions");
    expect(model.requests[0].headers.authorization).toBe("Bearer sk-secret");
    expect(model.requests[0].body).toMatchObject({ model: "test-model", stream: true });
    expect(model.requests[0].body).not.toHaveProperty("repetition_penalty");
    // Secrets are never returned in run config, including for loopback URLs.
    expect(detail.config.apiKey).toBe("***");

    const runsList = await fetch(`${apiUrl}/api/runs`).then((response) => response.json());
    expect(runsList.runs.map((run) => run.id)).toContain(created.id);

    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    expect(runDirs).toHaveLength(1);
    const runDir = join(rootDir, "benchmark-runs", runDirs[0]);
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8"));
      expect(runJson.status).toBe("completed");
    });
    const resultsJson = JSON.parse(await fs.readFile(join(runDir, "results.json"), "utf8"));
    expect(resultsJson).toHaveLength(2);
    // The persisted artifact contains only a redacted marker.
    const persistedRun = JSON.parse(await fs.readFile(join(runDir, "run.json"), "utf8"));
    expect(persistedRun.config.apiKey).toBe("***");
    const taskLogs = (await fs.readFile(join(runDir, "task-logs.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const logChannels = new Set(taskLogs.map((entry) => entry.channel));
    for (const channel of ["prompt", "model-output", "thinking-output", "extracted-code"]) {
      expect(logChannels).toContain(channel);
    }

    // SSE endpoint replays past events for late subscribers.
    const sseResponse = await fetch(`${apiUrl}/api/runs/${created.id}/events`);
    const reader = sseResponse.body.getReader();
    let sseText = "";
    while (!sseText.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      sseText += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(sseText).toContain("event: run-started");
    expect(sseText).toContain("event: task-finished");
  });

  it("uses a normal JSON completion when an endpoint ignores stream=true", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([nonStreamingGoodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);

    expect(detail.results[0]).toMatchObject({
      passed: true,
      rawOutput: expect.stringContaining("def add_one"),
      usage: { completion_tokens: 7 },
      finishReason: "stop"
    });
    expect(detail.events).toContainEqual(expect.objectContaining({
      type: "token",
      data: expect.objectContaining({ channel: "output" })
    }));
  });

  it("reads an SSE completion whose final frame has no blank-line delimiter", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([finalUndelimitedSseGoodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);

    expect(detail.results[0]).toMatchObject({
      passed: true,
      rawOutput: expect.stringContaining("def add_one"),
      usage: { completion_tokens: 7 },
      finishReason: "stop"
    });
  });

  it("records failing assertions when the model returns wrong code", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res, body) => sseFrames(res, ["```python\ndef add_one(x):\n    return x + 2\n```"], { entryPoint: entryPointFromRequest(body) })
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 0, failed: 1, finalScore: 0 });
    const [result] = detail.results;
    expect(result.passed).toBe(false);
    expect(result.tests.length).toBeGreaterThan(0);
    expect(result.tests.some((test) => !test.passed)).toBe(true);
    const failing = result.tests.find((test) => !test.passed);
    expect(failing).toMatchObject({ operator: "==" });
    expect(failing.actual).toBeDefined();
    expect(failing.expected).toBeDefined();
  });

  it("records a modelError result when the model endpoint fails, and the run continues", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      },
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0-1" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 2, passed: 1, failed: 1 });
    const failed = detail.results.find((result) => result.taskId === "HumanEval/0");
    expect(failed.modelError).toContain("HTTP 500");
    expect(failed.passed).toBe(false);
    const succeeded = detail.results.find((result) => result.taskId === "HumanEval/1");
    expect(succeeded.passed).toBe(true);
  });

  it("allows resuming a completed run whose only remaining failures are modelErrors", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No model loaded." } }));
      },
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ status: "completed", completed: 1, passed: 0, failed: 1 });
    expect(detail.results[0].modelError).toContain("HTTP 400");

    const resumed = await fetch(`${apiUrl}/api/runs/${created.id}/resume`, { method: "POST" }).then((response) => response.json());
    expect(resumed.status).toBe("queued");
    const resumedDetail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(resumedDetail).toMatchObject({ completed: 1, passed: 1, failed: 0 });
    expect(resumedDetail.results[0].modelError).toBeUndefined();
  });

  it("replaces saved request parameters with the current form config on resume", async () => {
    const rootDir = await makeRootDir();
    const originalEndpoint = await startModelServer([
      (request, response) => {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "Not Found" }));
      }
    ]);
    const correctedEndpoint = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, originalEndpoint.baseUrl, { testNumbers: "0" });
    await waitForStatus(apiUrl, created.id, ["completed"]);

    const resumeResponse = await fetch(`${apiUrl}/api/runs/${created.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        benchmark: "humaneval",
        baseUrl: correctedEndpoint.baseUrl,
        apiKey: "replacement-key",
        model: "replacement-model",
        maxOutputTokens: 768,
        thinkingEnabled: false,
        thinkingBudget: 4096,
        timeoutSeconds: 9,
        parallelTasks: 2,
        passCount: 1,
        adaptiveRepetitionPenalty: false,
        repetitionPenalty: 1.25,
        sampleLimit: 0,
        startIndex: 0,
        testNumbers: "0",
        systemPrompt: "Replacement system prompt",
        promptTemplate: "Replacement task: %problem_code%",
        temperature: 0.3,
        extraBody: { top_p: 0.7 }
      })
    });
    expect(resumeResponse.ok).toBe(true);
    const resumedDetail = await waitForStatus(apiUrl, created.id, ["completed"]);

    expect(correctedEndpoint.requests).toHaveLength(1);
    expect(correctedEndpoint.requests[0]).toMatchObject({
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer replacement-key" },
      body: {
        model: "replacement-model",
        temperature: 0.3,
        max_tokens: 768,
        top_p: 0.7,
        messages: [
          { role: "system", content: "Replacement system prompt" },
          { role: "user" }
        ]
      }
    });
    expect(resumedDetail.config).toMatchObject({
      baseUrl: correctedEndpoint.baseUrl,
      model: "replacement-model",
      maxOutputTokens: 768,
      thinkingEnabled: false,
      thinkingBudget: 4096,
      timeoutSeconds: 9,
      parallelTasks: 2,
      repetitionPenalty: 1.25,
      systemPrompt: "Replacement system prompt",
      promptTemplate: "Replacement task: %problem_code%",
      extraBody: { top_p: 0.7 }
    });
  });

  it("runs multiple passes with parallel workers and distinct attempt ids", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0-2", passCount: 2, parallelTasks: 2 });
    expect(created.total).toBe(6);
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 6, passed: 6, failed: 0, finalScore: 1 });
    const attemptIds = detail.results.map((result) => result.attemptId).sort();
    expect(attemptIds).toEqual([
      "HumanEval/0::pass-1",
      "HumanEval/0::pass-2",
      "HumanEval/1::pass-1",
      "HumanEval/1::pass-2",
      "HumanEval/2::pass-1",
      "HumanEval/2::pass-2"
    ]);
  });

  it("marks timed-out executions as failures with a timeout error", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res, body) => sseFrames(res, ["```python\ndef add_one(x):\n    while True:\n        pass\n```"], { entryPoint: entryPointFromRequest(body) })
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0", timeoutSeconds: 1 });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    const [result] = detail.results;
    expect(result.passed).toBe(false);
    expect(result.timeout).toBe(true);
    expect(result.error).toContain("timed out");
  }, 15_000);

  it("invalidates an incomplete model stream and reruns the task on resume", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "```python\ndef add_one(x):\n" } }] })}\n\n`);
        response.end();
      },
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    const interrupted = await waitForStatus(apiUrl, created.id, ["error"]);
    expect(interrupted).toMatchObject({ completed: 0, passed: 0, failed: 0, results: [] });
    expect(interrupted.events).toContainEqual(expect.objectContaining({
      type: "task-invalidated",
      data: expect.objectContaining({
        taskId: "HumanEval/0",
        attemptId: "HumanEval/0::pass-1",
        reason: "Model response stream ended before completion."
      })
    }));
    expect(interrupted.events.some((event) => event.type === "code-extracted")).toBe(false);

    await fetch(`${apiUrl}/api/runs/${created.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const completed = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(completed).toMatchObject({ completed: 1, passed: 1, failed: 0 });
    expect(completed.results).toHaveLength(1);
  });

  it("cancels a running run, then resumes it to completion", async () => {
    const rootDir = await makeRootDir();
    let hangingResponses = [];
    const model = await startModelServer([
      loopingModelHandler,
      (req, res) => {
        // Second request: stream one token, then hang until the client aborts.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        hangingResponses.push(res);
        req.on("close", () => res.end());
      },
      goodModelHandler,
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, {
      adaptiveRepetitionPenalty: true,
      repetitionPenalty: 0.5,
      testNumbers: "0-2"
    });
    await vi.waitFor(() => {
      expect(hangingResponses.length).toBe(1);
    });

    const cancelled = await fetch(`${apiUrl}/api/runs/${created.id}/cancel`, { method: "POST" }).then((response) => response.json());
    expect(cancelled.status === "cancelled" || cancelled.status === "running").toBe(true);
    const afterCancel = await waitForStatus(apiUrl, created.id, ["cancelled"]);
    expect(afterCancel).toMatchObject({ completed: 1, failed: 1 });
    expect(afterCancel.results[0]).toMatchObject({ looping: true, repetitionPenalty: 0.5 });

    const resumed = await fetch(`${apiUrl}/api/runs/${created.id}/resume`, { method: "POST" }).then((response) => response.json());
    expect(resumed.status).toBe("queued");
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 3, passed: 2, failed: 1 });
    expect(model.requests.map((request) => request.body.repetition_penalty)).toEqual([
      0.5,
      0.55,
      0.55,
      0.52
    ]);
    expect(detail.events.some((event) => event.type === "error")).toBe(false);
  }, 15_000);

  it("deletes a run and removes its artifacts from disk", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await waitForStatus(apiUrl, created.id, ["completed"]);

    const deleted = await fetch(`${apiUrl}/api/runs/${created.id}`, { method: "DELETE" }).then((response) => response.json());
    expect(deleted).toEqual({ ok: true });
    const missing = await fetch(`${apiUrl}/api/runs/${created.id}`);
    expect(missing.status).toBe(404);
    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    expect(runDirs).toHaveLength(0);
  });

  it("runs a bbeh-mini benchmark end to end with fuzzy answer scoring", async () => {
    const rootDir = await makeRootDir();
    await fs.mkdir(join(rootDir, ".cache", "bbeh"), { recursive: true });
    await fs.writeFile(join(rootDir, ".cache", "bbeh", "mini.json"), JSON.stringify({
      examples: [
        { input: "Is water wet? Reply Yes or No.", target: "Yes", subtask: "causal_understanding" },
        { input: "What is 3 + 4?", target: "7", subtask: "time_arithmetic" }
      ],
      canary: "test"
    }));
    const model = await startModelServer([
      (req, res, body) => {
        const question = body.messages.find((message) => message.role === "user")?.content || "";
        const answer = question.includes("water") ? "The answer is: yes." : "The answer is: 8.";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "pondering" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `I thought about it. ${answer}` } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const benchmarksResponse = await fetch(`${apiUrl}/api/benchmarks`).then((response) => response.json());
    // Built-ins come first; anything after them arrived from an optional
    // benchmark pack, which may not be installed.
    expect(benchmarksResponse.benchmarks.slice(0, 5).map((benchmark) => benchmark.id)).toEqual([
      "humaneval",
      "bbeh-mini",
      "bbeh-mini-official",
      "bbeh-full",
      "bbeh-full-official"
    ]);
    expect(benchmarksResponse.benchmarks.find((benchmark) => benchmark.id === "bbeh-mini").dataRevision).toBe(bbehDataRevision);

    const problemsResponse = await fetch(`${apiUrl}/api/benchmarks/bbeh-mini/problems`).then((response) => response.json());
    expect(problemsResponse).toMatchObject({ benchmark: "bbeh-mini", total: 2 });
    expect(problemsResponse.problems[0]).toEqual({ taskId: "bbeh_mini/0", subtask: "mini" });

    const created = await createRun(apiUrl, model.baseUrl, { benchmark: "bbeh-mini" });
    expect(created.benchmark).toBe("bbeh-mini");
    expect(created.benchmarkDataRevision).toBe(bbehDataRevision);
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({
      completed: 2,
      passed: 1,
      failed: 1,
      assertionsPassed: 1,
      assertionsTotal: 2
    });
    const correct = detail.results.find((result) => result.taskId === "bbeh_mini/0");
    expect(correct).toMatchObject({
      passed: true,
      subtask: "mini",
      extractedCode: "yes",
      expectedAnswer: "Yes",
      thinkingOutput: "pondering"
    });
    expect(correct.test).toBe("Expected answer: Yes");
    const wrong = detail.results.find((result) => result.taskId === "bbeh_mini/1");
    expect(wrong).toMatchObject({ passed: false, extractedCode: "8", expectedAnswer: "7" });
    expect(wrong.tests[0]).toMatchObject({ passed: false, actual: "8", expected: "7" });
    expect(detail.config).toMatchObject({ benchmark: "bbeh-mini" });
    expect(detail.benchmarkDataRevision).toBe(bbehDataRevision);
    // BBEH default prompts flow through when the client does not override them.
    expect(correct.instructionPrompt).toContain("The answer is: <answer>");
    expect(correct.instructionPrompt).toContain("Is water wet?");

    const runDirectories = await fs.readdir(join(rootDir, "benchmark-runs"));
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(rootDir, "benchmark-runs", runDirectories[0], "run.json"), "utf8"));
      expect(runJson.benchmarkDataRevision).toBe(bbehDataRevision);
    });
  });

  it("rejects resuming a BBEH run created with an older data revision", async () => {
    const rootDir = await makeRootDir();
    await fs.mkdir(join(rootDir, ".cache", "bbeh"), { recursive: true });
    await fs.writeFile(join(rootDir, ".cache", "bbeh", "mini.json"), JSON.stringify({
      examples: [{ input: "Is water wet?", target: "Yes" }]
    }));
    const hangingResponses = [];
    const model = await startModelServer([
      (request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        hangingResponses.push(response);
        request.on("close", () => response.end());
      }
    ]);
    const { app, apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { benchmark: "bbeh-mini" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    await fetch(`${apiUrl}/api/runs/${created.id}/cancel`, { method: "POST" });
    await waitForStatus(apiUrl, created.id, ["cancelled"]);

    app.runs.get(created.id).benchmarkDataRevision = null;
    const historicalRun = await fetch(`${apiUrl}/api/runs/${created.id}`).then((response) => response.json());
    expect(historicalRun.status).toBe("cancelled");

    const resumeResponse = await fetch(`${apiUrl}/api/runs/${created.id}/resume`, { method: "POST" });
    expect(resumeResponse.status).toBe(500);
    await expect(resumeResponse.json()).resolves.toEqual({
      error: `Run uses benchmark data revision "unversioned", but the current revision is "${bbehDataRevision}". Start a new run instead.`
    });
  });

  it("reloads persisted runs after a restart with results and config intact", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const first = await startRuntime(rootDir);

    const created = await createRun(first.apiUrl, model.baseUrl, { testNumbers: "0-1", maxOutputTokens: 999 });
    await waitForStatus(first.apiUrl, created.id, ["completed"]);
    // Artifact writes are fire-and-forget; wait for the persisted status.
    const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
    await vi.waitFor(async () => {
      const runJson = JSON.parse(await fs.readFile(join(rootDir, "benchmark-runs", runDirs[0], "run.json"), "utf8"));
      expect(runJson.status).toBe("completed");
    });

    const second = await startRuntime(rootDir);
    const reloaded = await fetch(`${second.apiUrl}/api/runs/${created.id}`).then((response) => response.json());
    expect(reloaded).toMatchObject({
      id: created.id,
      status: "completed",
      completed: 2,
      passed: 2,
      model: "test-model"
    });
    expect(reloaded.config).toMatchObject({ maxOutputTokens: 999, testNumbers: "0-1" });
    expect(reloaded.results).toHaveLength(2);
    expect(reloaded.results[0].extractedCode).toBe(goodSolutions.add_one);
  });

  it("reloads a saved provider key from the credential store across restart and resume", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
        hangingResponses.push(res);
        req.on("close", () => res.end());
      },
      goodModelHandler
    ]);
    const providerStore = {
      resolve: vi.fn(async (id) => {
        if (id !== "local-secure") throw new Error("Saved provider not found.");
        return { id, name: "Local secure", baseUrl: model.baseUrl, apiKey: "sk-secret" };
      }),
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn()
    };
    const first = await startRuntime(rootDir, { providerStore });

    const created = await createRun(first.apiUrl, model.baseUrl, { providerId: "local-secure", testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    await fetch(`${first.apiUrl}/api/runs/${created.id}/cancel`, { method: "POST" });
    await waitForStatus(first.apiUrl, created.id, ["cancelled"]);

    // A fresh process reloads the key from the credential store, while API
    // responses and run artifacts remain redacted.
    const second = await startRuntime(rootDir, { providerStore });
    const reloaded = await fetch(`${second.apiUrl}/api/runs/${created.id}`).then((response) => response.json());
    expect(reloaded.config).toMatchObject({ providerId: "local-secure", apiKey: "***" });

    const resumed = await fetch(`${second.apiUrl}/api/runs/${created.id}/resume`, { method: "POST" }).then((response) => response.json());
    expect(resumed.status).toBe("queued");
    const detail = await waitForStatus(second.apiUrl, created.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 1 });
    expect(model.requests.at(-1).headers.authorization).toBe("Bearer sk-secret");
  });

  it("uses the api key sent with a resume request instead of the run's stored one", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not authenticated" } }));
      },
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await createRun(apiUrl, model.baseUrl, { apiKey: "sk-wrong", testNumbers: "0" });
    const detail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(detail.results[0].modelError).toContain("HTTP 401");

    const resumeResponse = await fetch(`${apiUrl}/api/runs/${created.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-correct" })
    });
    const resumed = await resumeResponse.json();
    expect(resumed.status).toBe("queued");
    // The field's value replaced the stored key, so the retried request
    // succeeds and the persisted config reflects it (local endpoint).
    expect(resumed.config.apiKey).toBe("***");
    const resumedDetail = await waitForStatus(apiUrl, created.id, ["completed"]);
    expect(resumedDetail).toMatchObject({ completed: 1, passed: 1, failed: 0 });
    expect(model.requests.at(-1).headers.authorization).toBe("Bearer sk-correct");
  });

  it("sends thinking configuration and a combined token budget to the model", async () => {
    const rootDir = await makeRootDir();
    const model = await startModelServer([goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const withThinking = await createRun(apiUrl, model.baseUrl, {
      testNumbers: "0",
      maxOutputTokens: 700,
      thinkingEnabled: true,
      thinkingBudget: 300
    });
    await waitForStatus(apiUrl, withThinking.id, ["completed"]);

    expect(model.requests[0].body).toMatchObject({
      max_tokens: 1000,
      enable_thinking: true,
      thinking_budget: 300,
      chat_template_kwargs: { enable_thinking: true }
    });

    const withoutThinking = await createRun(apiUrl, model.baseUrl, {
      testNumbers: "0",
      maxOutputTokens: 700,
      thinkingEnabled: false,
      thinkingBudget: 300
    });
    await waitForStatus(apiUrl, withoutThinking.id, ["completed"]);

    expect(model.requests[1].body).toMatchObject({
      max_tokens: 700,
      enable_thinking: false,
      thinking_budget: 0,
      chat_template_kwargs: { enable_thinking: false }
    });
  });

  it("runs different remote providers concurrently but serializes each provider's queue", async () => {
    const rootDir = await makeRootDir();
    const starts = [];
    const releases = [];
    const providerConfigs = new Map([
      ["azure", { id: "azure", name: "Azure", baseUrl: "https://azure.test/v1", apiKey: "az-key" }],
      ["openai", { id: "openai", name: "OpenAI", baseUrl: "https://openai.test/v1", apiKey: "oa-key" }]
    ]);
    const providerStore = {
      resolve: vi.fn(async (id) => {
        const provider = providerConfigs.get(id);
        if (!provider) throw new Error("Saved provider not found.");
        return provider;
      }),
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn()
    };
    const encoder = new TextEncoder();
    const { apiUrl } = await startRuntime(rootDir, {
      providerStore,
      fetchImplementation: async (url, options) => {
        if (!String(url).endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const body = JSON.parse(options.body);
        const entryPoint = entryPointFromRequest(body);
        return new Response(new ReadableStream({
          start(controller) {
            starts.push(String(url));
            releases.push(() => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `\`\`\`python\n${goodSolutions[entryPoint]}\n\`\`\`` } }] })}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            });
          }
        }), { headers: { "content-type": "text/event-stream" } });
      }
    });

    const azureFirst = await createRun(apiUrl, "https://ignored.test/v1", { providerId: "azure", testNumbers: "0" });
    await vi.waitFor(() => expect(starts).toEqual(["https://azure.test/v1/chat/completions"]));
    const openaiRun = await createRun(apiUrl, "https://ignored.test/v1", { providerId: "openai", testNumbers: "1" });
    await vi.waitFor(() => expect(starts).toContain("https://openai.test/v1/chat/completions"));
    const azureSecond = await createRun(apiUrl, "https://ignored.test/v1", { providerId: "azure", testNumbers: "2" });

    expect(openaiRun.queuePosition).toBeNull();
    expect(azureSecond).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(starts).toHaveLength(2);

    releases[0]();
    releases[1]();
    await waitForStatus(apiUrl, azureFirst.id, ["completed"]);
    await waitForStatus(apiUrl, openaiRun.id, ["completed"]);
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2]).toBe("https://azure.test/v1/chat/completions");
    releases[2]();
    await waitForStatus(apiUrl, azureSecond.id, ["completed"]);
  }, 15_000);

  it("shares one local execution lane across providers on different ports", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const firstModel = await startModelServer([makeHangingModelHandler(hangingResponses)]);
    const secondModel = await startModelServer([goodModelHandler]);
    const providerStore = {
      resolve: vi.fn(async (id) => id === "local-a"
        ? { id, name: "Local A", baseUrl: firstModel.baseUrl, apiKey: "" }
        : { id, name: "Local B", baseUrl: secondModel.baseUrl, apiKey: "" }),
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn()
    };
    const { apiUrl } = await startRuntime(rootDir, { providerStore });

    const first = await createRun(apiUrl, firstModel.baseUrl, { providerId: "local-a", testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    const second = await createRun(apiUrl, secondModel.baseUrl, { providerId: "local-b", testNumbers: "1" });

    expect(second).toMatchObject({ status: "queued", queuePosition: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondModel.requests).toHaveLength(0);

    await fetch(`${apiUrl}/api/runs/${first.id}/cancel`, { method: "POST" });
    await waitForStatus(apiUrl, second.id, ["completed"]);
    expect(secondModel.requests).toHaveLength(1);
  }, 15_000);

  it("queues new runs behind the active one and starts them strictly one at a time", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([
      makeHangingModelHandler(hangingResponses),
      makeHangingModelHandler(hangingResponses),
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const first = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));

    const second = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    expect(second).toMatchObject({ status: "queued", queuePosition: 1 });
    const third = await createRun(apiUrl, model.baseUrl, { testNumbers: "2" });
    expect(third).toMatchObject({ status: "queued", queuePosition: 2 });

    // Queued runs never touch the model while the first run is active.
    expect(model.requests).toHaveLength(1);
    const listed = await fetch(`${apiUrl}/api/runs`).then((response) => response.json());
    const listedById = new Map(listed.runs.map((run) => [run.id, run]));
    expect(listedById.get(second.id)).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(listedById.get(third.id)).toMatchObject({ status: "queued", queuePosition: 2 });

    await fetch(`${apiUrl}/api/runs/${first.id}/cancel`, { method: "POST" });
    await waitForStatus(apiUrl, first.id, ["cancelled"]);
    // Exactly one queued run is promoted; the one behind it keeps waiting.
    const secondRunning = await waitForStatus(apiUrl, second.id, ["running"]);
    expect(secondRunning.queuePosition).toBeNull();
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(2));
    const thirdWaiting = await fetch(`${apiUrl}/api/runs/${third.id}`).then((response) => response.json());
    expect(thirdWaiting).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(model.requests).toHaveLength(2);

    await fetch(`${apiUrl}/api/runs/${second.id}/cancel`, { method: "POST" });
    await waitForStatus(apiUrl, second.id, ["cancelled"]);
    const thirdDetail = await waitForStatus(apiUrl, third.id, ["completed"]);
    expect(thirdDetail).toMatchObject({ completed: 1, passed: 1, queuePosition: null });
  }, 15_000);

  it("starts exactly one run from a burst of simultaneous creates", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([makeHangingModelHandler(hangingResponses), goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const created = await Promise.all([
      createRun(apiUrl, model.baseUrl, { testNumbers: "0" }),
      createRun(apiUrl, model.baseUrl, { testNumbers: "1" }),
      createRun(apiUrl, model.baseUrl, { testNumbers: "2" })
    ]);
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));

    // However the burst interleaved, exactly one run occupies the slot and
    // the other two wait with distinct positions.
    const listed = await fetch(`${apiUrl}/api/runs`).then((response) => response.json());
    const states = created.map((run) => listed.runs.find((candidate) => candidate.id === run.id));
    const running = states.filter((run) => run.status === "running" || (run.status === "queued" && !run.queuePosition));
    const waiting = states.filter((run) => run.status === "queued" && run.queuePosition);
    expect(running).toHaveLength(1);
    expect(waiting.map((run) => run.queuePosition).sort()).toEqual([1, 2]);
    expect(model.requests).toHaveLength(1);

    await fetch(`${apiUrl}/api/runs/${running[0].id}/cancel`, { method: "POST" });
    for (const run of waiting) {
      const detail = await waitForStatus(apiUrl, run.id, ["completed"]);
      expect(detail).toMatchObject({ completed: 1, passed: 1, queuePosition: null });
    }
  }, 15_000);

  it("queues a new run behind a resumed one", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No model loaded." } }));
      },
      makeHangingModelHandler(hangingResponses),
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const stalled = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await waitForStatus(apiUrl, stalled.id, ["completed"]);
    await fetch(`${apiUrl}/api/runs/${stalled.id}/resume`, { method: "POST" });
    // The resumed run's retried task hangs, so the resume occupies the slot.
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));

    const queued = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    expect(queued).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(model.requests).toHaveLength(2);

    await fetch(`${apiUrl}/api/runs/${stalled.id}/cancel`, { method: "POST" });
    const detail = await waitForStatus(apiUrl, queued.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 1, queuePosition: null });
  }, 15_000);

  it("releases the execution slot when the active run is deleted", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([makeHangingModelHandler(hangingResponses), goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const active = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    const queued = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    expect(queued).toMatchObject({ status: "queued", queuePosition: 1 });

    await fetch(`${apiUrl}/api/runs/${active.id}`, { method: "DELETE" });
    const detail = await waitForStatus(apiUrl, queued.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 1, queuePosition: null });
    const missing = await fetch(`${apiUrl}/api/runs/${active.id}`);
    expect(missing.status).toBe(404);
  }, 15_000);

  it("takes a cancelled queued run out of the line and moves later runs up", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([makeHangingModelHandler(hangingResponses), goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const first = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    const second = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    const third = await createRun(apiUrl, model.baseUrl, { testNumbers: "2" });

    const removed = await fetch(`${apiUrl}/api/runs/${second.id}/cancel`, { method: "POST" })
      .then((response) => response.json());
    expect(removed).toMatchObject({ status: "cancelled", queuePosition: null });
    const thirdAfterRemoval = await fetch(`${apiUrl}/api/runs/${third.id}`).then((response) => response.json());
    expect(thirdAfterRemoval).toMatchObject({ status: "queued", queuePosition: 1 });

    await fetch(`${apiUrl}/api/runs/${first.id}/cancel`, { method: "POST" });
    const thirdDetail = await waitForStatus(apiUrl, third.id, ["completed"]);
    expect(thirdDetail).toMatchObject({ completed: 1, passed: 1 });
    // The dequeued run never started and stays resumable later.
    const secondDetail = await fetch(`${apiUrl}/api/runs/${second.id}`).then((response) => response.json());
    expect(secondDetail).toMatchObject({ status: "cancelled", completed: 0 });
    expect(model.requests).toHaveLength(2);

    // A run cancelled out of the queue re-enqueues cleanly via resume.
    const requeued = await fetch(`${apiUrl}/api/runs/${second.id}/resume`, { method: "POST" })
      .then((response) => response.json());
    expect(requeued).toMatchObject({ status: "queued", queuePosition: 1 });
    const requeuedDetail = await waitForStatus(apiUrl, second.id, ["completed"]);
    expect(requeuedDetail).toMatchObject({ completed: 1, passed: 1, queuePosition: null });
  }, 15_000);

  it("drops a deleted queued run from the line", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([makeHangingModelHandler(hangingResponses), goodModelHandler]);
    const { apiUrl } = await startRuntime(rootDir);

    const first = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    const second = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    const third = await createRun(apiUrl, model.baseUrl, { testNumbers: "2" });
    expect(third.queuePosition).toBe(2);

    await fetch(`${apiUrl}/api/runs/${second.id}`, { method: "DELETE" });
    const thirdAfterDelete = await fetch(`${apiUrl}/api/runs/${third.id}`).then((response) => response.json());
    expect(thirdAfterDelete).toMatchObject({ status: "queued", queuePosition: 1 });

    await fetch(`${apiUrl}/api/runs/${first.id}/cancel`, { method: "POST" });
    const thirdDetail = await waitForStatus(apiUrl, third.id, ["completed"]);
    expect(thirdDetail).toMatchObject({ completed: 1, passed: 1 });
    const missing = await fetch(`${apiUrl}/api/runs/${second.id}`);
    expect(missing.status).toBe(404);
    expect(model.requests).toHaveLength(2);
  }, 15_000);

  it("persists a waiting queued run so a restart reloads it as interrupted", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([makeHangingModelHandler(hangingResponses), goodModelHandler]);
    const first = await startRuntime(rootDir);

    const active = await createRun(first.apiUrl, model.baseUrl, { testNumbers: "0" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));
    const queued = await createRun(first.apiUrl, model.baseUrl, { testNumbers: "1" });
    expect(queued.status).toBe("queued");
    // Artifact writes are fire-and-forget; wait until the waiting run's
    // queued state has actually reached disk.
    await vi.waitFor(async () => {
      const runDirs = await fs.readdir(join(rootDir, "benchmark-runs"));
      const queuedDir = runDirs.find((dir) => dir.endsWith(queued.id));
      expect(queuedDir).toBeTruthy();
      const runJson = JSON.parse(await fs.readFile(join(rootDir, "benchmark-runs", queuedDir, "run.json"), "utf8"));
      expect(runJson.status).toBe("queued");
    });

    // The queue itself does not survive a restart, but the run must: it
    // reloads as "interrupted" (resumable) rather than vanishing.
    const second = await startRuntime(rootDir);
    const reloaded = await fetch(`${second.apiUrl}/api/runs/${queued.id}`).then((response) => response.json());
    expect(reloaded).toMatchObject({ status: "interrupted", queuePosition: null, completed: 0 });

    // Unblock the hanging model connection so harness cleanup can close it.
    await fetch(`${first.apiUrl}/api/runs/${active.id}/cancel`, { method: "POST" });
    await waitForStatus(first.apiUrl, queued.id, ["completed"]);
  }, 15_000);

  it("queues a resume while another run is active", async () => {
    const rootDir = await makeRootDir();
    const hangingResponses = [];
    const model = await startModelServer([
      (req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No model loaded." } }));
      },
      makeHangingModelHandler(hangingResponses),
      goodModelHandler
    ]);
    const { apiUrl } = await startRuntime(rootDir);

    const stalled = await createRun(apiUrl, model.baseUrl, { testNumbers: "0" });
    await waitForStatus(apiUrl, stalled.id, ["completed"]);
    const active = await createRun(apiUrl, model.baseUrl, { testNumbers: "1" });
    await vi.waitFor(() => expect(hangingResponses).toHaveLength(1));

    const resumed = await fetch(`${apiUrl}/api/runs/${stalled.id}/resume`, { method: "POST" })
      .then((response) => response.json());
    expect(resumed).toMatchObject({ status: "queued", queuePosition: 1 });
    // The resume waits in line while the active run keeps its slot.
    const stillQueued = await fetch(`${apiUrl}/api/runs/${stalled.id}`).then((response) => response.json());
    expect(stillQueued).toMatchObject({ status: "queued", queuePosition: 1 });
    // Resuming a run that is already waiting in line is rejected, so a
    // double-click cannot enqueue the same run twice.
    const doubleResume = await fetch(`${apiUrl}/api/runs/${stalled.id}/resume`, { method: "POST" });
    expect(doubleResume.status).toBe(500);
    await expect(doubleResume.json()).resolves.toEqual({ error: "Run cannot be resumed." });

    await fetch(`${apiUrl}/api/runs/${active.id}/cancel`, { method: "POST" });
    const detail = await waitForStatus(apiUrl, stalled.id, ["completed"]);
    expect(detail).toMatchObject({ completed: 1, passed: 1, failed: 0, queuePosition: null });
  }, 15_000);
});
