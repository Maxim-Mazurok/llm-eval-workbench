import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = Number(process.env.LLM_EVAL_PORT || 8787);
const frontendPort = Number(process.env.LLM_EVAL_FRONTEND_PORT || 5173);
const endpointUrl = `http://127.0.0.1:${port}/api/runs`;
const retryDelayMilliseconds = 100;
const viteCommand = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

async function waitForBenchmarkServer() {
  while (true) {
    try {
      const response = await fetch(endpointUrl);
      if (response.ok) {
        console.log(`Benchmark API is ready at ${endpointUrl}`);
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, retryDelayMilliseconds));
  }
}

await waitForBenchmarkServer();

const viteProcess = spawn(process.execPath, [
  viteCommand,
  "--host",
  "0.0.0.0",
  "--port",
  String(frontendPort)
], {
  stdio: "inherit"
});

function stopVite(signal) {
  viteProcess.kill(signal);
}

process.once("SIGINT", () => stopVite("SIGINT"));
process.once("SIGTERM", () => stopVite("SIGTERM"));

const viteExitCode = await new Promise((resolve, reject) => {
  viteProcess.once("error", reject);
  viteProcess.once("exit", resolve);
});

process.exitCode = viteExitCode ?? 1;