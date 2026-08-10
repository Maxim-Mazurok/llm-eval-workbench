import { useCallback, useEffect, useState } from "react";
import { BENCH_API } from "../domain/benchmark";

/**
 * Model ids served by the configured OpenAI-compatible endpoint, fetched
 * through the benchmark server's /api/models proxy (no cross-origin call).
 * Feeds the model combobox; an unreachable endpoint just yields an empty list
 * so the input keeps working as free text. `refresh` refetches on demand —
 * the combobox calls it every time it opens, so a model server or benchmark
 * server (re)started after page load still populates the list. Note the
 * /v1/models reply carries no vision-capability flag, so the list cannot be
 * filtered per benchmark.
 */
export function useAvailableModels(baseUrl: string, apiKey: string): {
  models: string[];
  /**
   * id → model_type from oMLX's admin API via the proxy ("vlm" = vision).
   * Missing entries mean the endpoint exposes no capability data.
   */
  modelTypes: Record<string, string>;
  refresh: () => void;
} {
  const [models, setModels] = useState<string[]>([]);
  const [modelTypes, setModelTypes] = useState<Record<string, string>>({});
  const [fetchTick, setFetchTick] = useState(0);
  const refresh = useCallback(() => setFetchTick((tick) => tick + 1), []);
  useEffect(() => {
    const trimmed = baseUrl.trim();
    if (!trimmed) {
      setModels([]);
      setModelTypes({});
      return;
    }
    const controller = new AbortController();
    // Debounced: baseUrl changes on every keystroke while the user edits it.
    const timer = setTimeout(async () => {
      try {
        const trimmedApiKey = apiKey.trim();
        const response = await fetch(
          `${BENCH_API}/api/models?baseUrl=${encodeURIComponent(trimmed)}`,
          {
            signal: controller.signal,
            ...(trimmedApiKey ? { headers: { authorization: `Bearer ${trimmedApiKey}` } } : {})
          }
        );
        if (!response.ok) {
          setModels([]);
          setModelTypes({});
          return;
        }
        const payload = (await response.json()) as {
          models?: Array<{ id?: unknown; modelType?: unknown }>;
        };
        const entries = Array.isArray(payload.models) ? payload.models : [];
        setModels(
          entries.map((model) => model.id).filter((id): id is string => typeof id === "string")
        );
        setModelTypes(
          Object.fromEntries(
            entries
              .filter(
                (model): model is { id: string; modelType: string } =>
                  typeof model.id === "string" && typeof model.modelType === "string"
              )
              .map((model) => [model.id, model.modelType])
          )
        );
      } catch {
        // Keep the previous list on a refresh failure; free text still works.
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiKey, baseUrl, fetchTick]);
  return { models, modelTypes, refresh };
}
