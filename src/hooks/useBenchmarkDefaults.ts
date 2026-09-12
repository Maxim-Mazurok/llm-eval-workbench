import { useEffect, useState } from "react";
import { BENCH_API } from "../domain/benchmark";

/**
 * Default system prompt per benchmark id, read from the server's benchmark
 * registry. Some pack benchmarks ship their prompt with their dataset instead
 * of declaring it client-side, so the form has to ask the server for it. An
 * unreachable server just yields an empty map and the form falls back to
 * whatever the benchmark option declares.
 */
export function useBenchmarkDefaults(): Record<string, string> {
  const [systemPromptByBenchmark, setSystemPromptByBenchmark] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`${BENCH_API}/api/benchmarks`, { signal: controller.signal });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          benchmarks?: Array<{ id?: unknown; defaultSystemPrompt?: unknown }>;
        };
        const entries = Array.isArray(payload.benchmarks) ? payload.benchmarks : [];
        setSystemPromptByBenchmark(
          Object.fromEntries(
            entries
              .filter(
                (benchmark): benchmark is { id: string; defaultSystemPrompt: string } =>
                  typeof benchmark.id === "string" &&
                  typeof benchmark.defaultSystemPrompt === "string" &&
                  benchmark.defaultSystemPrompt.length > 0
              )
              .map((benchmark) => [benchmark.id, benchmark.defaultSystemPrompt])
          )
        );
      } catch {
        // Server down or the request was aborted: keep the declared defaults.
      }
    })();
    return () => controller.abort();
  }, []);
  return systemPromptByBenchmark;
}
