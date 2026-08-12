import { useCallback, useEffect, useState } from "react";
import { BENCH_API } from "../domain/benchmark";

/**
 * Model ids served by the selected saved provider, fetched
 * through the benchmark server's /api/models proxy (no cross-origin call).
 * Feeds the model combobox; an unreachable endpoint just yields an empty list
 * so the input keeps working as free text. `refresh` refetches on demand —
 * the combobox calls it every time it opens, so a model server or benchmark
 * server (re)started after page load still populates the list. Note the
 * /v1/models reply carries no vision-capability flag, so the list cannot be
 * filtered per benchmark.
 */
export function useAvailableModels(providerId: string): {
  models: string[];
  /**
   * id → model_type from oMLX's admin API via the proxy ("vlm" = vision).
   * Missing entries mean the endpoint exposes no capability data.
   */
  modelTypes: Record<string, string>;
  /** True until the selected provider's model request has settled. */
  loading: boolean;
  refresh: () => void;
} {
  const [models, setModels] = useState<string[]>([]);
  const [modelTypes, setModelTypes] = useState<Record<string, string>>({});
  const [loadedProviderId, setLoadedProviderId] = useState("");
  const [fetchTick, setFetchTick] = useState(0);
  const refresh = useCallback(() => setFetchTick((tick) => tick + 1), []);
  const trimmed = providerId.trim();
  // Compare the result's provider rather than relying on an effect to set a
  // loading flag: this makes the loading state visible in the same render as a
  // provider change, before the old model list could be shown.
  const loading = Boolean(trimmed) && loadedProviderId !== trimmed;

  useEffect(() => {
    if (!trimmed) {
      setModels([]);
      setModelTypes({});
      setLoadedProviderId("");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${BENCH_API}/api/models?providerId=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal
        });
        if (!response.ok) {
          setModels([]);
          setModelTypes({});
          setLoadedProviderId(trimmed);
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
        setLoadedProviderId(trimmed);
      } catch {
        if (controller.signal.aborted) return;
        // The endpoint may be offline; free text remains available.
        setModels([]);
        setModelTypes({});
        setLoadedProviderId(trimmed);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [fetchTick, providerId]);
  return {
    models: loading ? [] : models,
    modelTypes: loading ? {} : modelTypes,
    loading,
    refresh
  };
}
