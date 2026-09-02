import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Unlike notifications.spec.ts, nothing here is mocked: the page talks to the
// real benchmark server (started by playwright.config.ts on an ephemeral port
// with an isolated root directory), which calls the OpenAI-compatible stub
// below. These tests prove the run queue end to end: clicking "Add to queue"
// while a run is in progress must never start a second model conversation.

const benchmarkApiUrl = process.env.PLAYWRIGHT_BENCH_API_URL || "http://localhost:8787";

const solutions: Record<string, string> = {
  add_one: "def add_one(x):\n    return x + 1",
  double: "def double(x):\n    return x * 2",
  negate: "def negate(x):\n    return -x"
};

type ModelStub = {
  baseUrl: string;
  chatRequestCount: () => number;
  close: () => Promise<void>;
};

// A tiny OpenAI-compatible endpoint. The first chat request streams one token
// and then hangs until the benchmark server aborts it, keeping its run alive
// for as long as a test needs; later requests answer with the correct
// solution so their tasks complete and pass. Concurrency is asserted through
// chatRequestCount during hold windows plus the benchmark API's own run
// states — raw in-flight socket counting would misread the moment the server
// aborts the hanging call and immediately starts the promoted run.
async function startModelStub(): Promise<ModelStub> {
  let chatRequests = 0;
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (!request.url?.endsWith("/chat/completions")) {
      // /v1/models autocomplete probe (and the oMLX admin probe).
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    chatRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (chatRequests === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      request.on("close", () => response.end());
      return;
    }
    const prompt = String(
      JSON.parse(body).messages?.find((message: { role: string }) => message.role === "user")?.content ?? ""
    );
    const entryPoint = /def (\w+)\(/.exec(prompt)?.[1] ?? "add_one";
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: `\`\`\`python\n${solutions[entryPoint]}\n\`\`\`` } }]
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 5 }
    })}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatRequestCount: () => chatRequests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}

async function fetchRunStates(): Promise<Map<string, { status: string; queuePosition: number | null }>> {
  const payload = await fetch(`${benchmarkApiUrl}/api/runs`).then((response) => response.json());
  return new Map(payload.runs.map((run: { model: string; status: string; queuePosition: number | null }) => [
    run.model,
    { status: run.status, queuePosition: run.queuePosition ?? null }
  ]));
}

async function configureLocalProvider(baseUrl: string) {
  const response = await fetch(`${benchmarkApiUrl}/api/providers/local-default`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Queue test model", baseUrl })
  });
  expect(response.ok).toBe(true);
}

async function submitRunForm(page: Page, model: string, testNumbers: string, buttonName: RegExp) {
  await page.getByPlaceholder("provider/model-name").fill(model);
  // Close the model combobox suggestions so they cannot cover the buttons.
  await page.keyboard.press("Escape");
  await page.getByLabel("Test numbers").fill(testNumbers);
  await page.getByRole("button", { name: buttonName }).click();
}

function runTab(page: Page, model: string, status: string) {
  return page.getByRole("button", { name: new RegExp(`${model}.*${status}|${status}.*${model}`, "i") });
}

test("queues a run started from the UI while another is running, then runs it", async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
  const model = await startModelStub();
  try {
    await configureLocalProvider(model.baseUrl);
    await page.goto("/");
    await submitRunForm(page, "qa-model", "0", /start run/i);
    // The first task's model call hangs, so the run stays in progress.
    await expect(runTab(page, "qa-model", "running")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new bench/i }).click();
    // With a live run, the primary action reads "Add to queue".
    await expect(page.getByRole("button", { name: /add to queue/i })).toBeVisible();
    await submitRunForm(page, "qb-model", "1", /add to queue/i);

    // The new run waits in line instead of starting.
    await expect(runTab(page, "qb-model", "queued")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Remove benchmark run qb-model from queue (position 1)" }))
      .toHaveText("1");
    // Give a broken queue a moment to (incorrectly) start the queued run,
    // then confirm the queued run never spoke to the model and the benchmark
    // server itself still reports it as waiting.
    await page.waitForTimeout(1_500);
    expect(model.chatRequestCount()).toBe(1);
    const heldStates = await fetchRunStates();
    expect(heldStates.get("qa-model")).toEqual({ status: "running", queuePosition: null });
    expect(heldStates.get("qb-model")).toEqual({ status: "queued", queuePosition: 1 });

    // Stopping the active run promotes the queued one automatically.
    await runTab(page, "qa-model", "running").click();
    await page.getByRole("button", { name: /stop selected/i }).click();
    await expect(runTab(page, "qb-model", "completed")).toBeVisible({ timeout: 30_000 });
    // Exactly one model conversation per run: the hanging one, then the
    // promoted run's — never a third, never a duplicate.
    expect(model.chatRequestCount()).toBe(2);
    const drainedStates = await fetchRunStates();
    expect(drainedStates.get("qa-model")).toEqual({ status: "cancelled", queuePosition: null });
    expect(drainedStates.get("qb-model")).toEqual({ status: "completed", queuePosition: null });
    await expect(page.getByRole("button", { name: /remove benchmark run qb-model from queue/i })).toHaveCount(0);
  } finally {
    await model.close();
  }
});

test("removes a queued run from the line via its badge and renumbers the rest", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  const model = await startModelStub();
  try {
    await configureLocalProvider(model.baseUrl);
    await page.goto("/");
    await submitRunForm(page, "qc-model", "0", /start run/i);
    await expect(runTab(page, "qc-model", "running")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new bench/i }).click();
    await submitRunForm(page, "qd-model", "1", /add to queue/i);
    await expect(page.getByRole("button", { name: "Remove benchmark run qd-model from queue (position 1)" }))
      .toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /new bench/i }).click();
    await submitRunForm(page, "qe-model", "2", /add to queue/i);
    await expect(page.getByRole("button", { name: "Remove benchmark run qe-model from queue (position 2)" }))
      .toBeVisible({ timeout: 15_000 });

    // Hovering the badge swaps the position number for a remove control;
    // clicking it takes the run out of line and the one behind it moves up.
    const removalBadge = page.getByRole("button", { name: "Remove benchmark run qd-model from queue (position 1)" });
    await removalBadge.hover();
    await expect(removalBadge.locator(".queue-badge-remove")).toBeVisible();
    await expect(removalBadge.locator(".queue-badge-position")).toBeHidden();
    await removalBadge.click();

    await expect(runTab(page, "qd-model", "cancelled")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Remove benchmark run qe-model from queue (position 1)" }))
      .toBeVisible({ timeout: 15_000 });
    // Only the hanging first call ever reached the model.
    expect(model.chatRequestCount()).toBe(1);
    const lineStates = await fetchRunStates();
    expect(lineStates.get("qd-model")).toEqual({ status: "cancelled", queuePosition: null });
    expect(lineStates.get("qe-model")).toEqual({ status: "queued", queuePosition: 1 });

    // Drain the queue: stop the active run; the remaining queued run finishes
    // and the removed run never gets a model call.
    await runTab(page, "qc-model", "running").click();
    await page.getByRole("button", { name: /stop selected/i }).click();
    await expect(runTab(page, "qe-model", "completed")).toBeVisible({ timeout: 30_000 });
    expect(model.chatRequestCount()).toBe(2);
  } finally {
    await model.close();
  }
});
