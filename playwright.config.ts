import { defineConfig, devices } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function allocateAvailablePort() {
  const reservationServer = createServer();
  await new Promise<void>((resolve, reject) => {
    reservationServer.once("error", reject);
    reservationServer.listen(0, "127.0.0.1", resolve);
  });
  const address = reservationServer.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a Playwright port.");
  const allocatedPort = address.port;
  await new Promise<void>((resolve, reject) => reservationServer.close((error) => (
    error ? reject(error) : resolve()
  )));
  return allocatedPort;
}

// The benchmark server under test gets its own throwaway root directory so
// its artifacts and dataset cache never mix with a developer's live server
// (which may be mid-run while the e2e suite executes).
const benchRootDir = fileURLToPath(new URL("./test-results/e2e-bench-root", import.meta.url));
rmSync(benchRootDir, { recursive: true, force: true });
mkdirSync(join(benchRootDir, ".cache"), { recursive: true });
writeFileSync(join(benchRootDir, ".cache", "HumanEval.jsonl"), [
  {
    task_id: "HumanEval/0",
    prompt: "def add_one(x):\n    \"\"\"Add one.\"\"\"\n",
    entry_point: "add_one",
    canonical_solution: "    return x + 1\n",
    test: "def check(candidate):\n    assert candidate(1) == 2\n"
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
].map((problem) => JSON.stringify(problem)).join("\n"));

const frontendPort = Number(process.env.PLAYWRIGHT_FRONTEND_PORT) || await allocateAvailablePort();
let benchmarkPort = Number(process.env.PLAYWRIGHT_BENCHMARK_PORT) || await allocateAvailablePort();
while (benchmarkPort === frontendPort) benchmarkPort = await allocateAvailablePort();
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const benchmarkApiUrl = `http://127.0.0.1:${benchmarkPort}`;
process.env.PLAYWRIGHT_FRONTEND_PORT = String(frontendPort);
process.env.PLAYWRIGHT_BENCHMARK_PORT = String(benchmarkPort);
process.env.PLAYWRIGHT_BENCH_API_URL = benchmarkApiUrl;

export default defineConfig({
  testDir: "./tests/e2e",
  webServer: {
    command: `LLM_EVAL_ROOT_DIR="${benchRootDir}" LLM_EVAL_PORT=${benchmarkPort} LLM_EVAL_FRONTEND_PORT=${frontendPort} VITE_BENCH_API_URL=${benchmarkApiUrl} npm run dev`,
    url: frontendUrl,
    reuseExistingServer: false
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: frontendUrl
  }
});
