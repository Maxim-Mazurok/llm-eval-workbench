import { useCallback, useEffect, useState } from "react";
import { BENCH_API } from "../domain/benchmark";
import type { ProviderConfig, ProviderInput } from "../domain/providers";

const compatibilityLocalProvider: ProviderConfig = {
  id: "local-default",
  name: "Local model server",
  baseUrl: "http://localhost:8000/v1",
  hasApiKey: false
};

async function responseJson(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Provider request failed.");
  return json;
}

export function useProviders(onError: (message: string) => void) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const response = await fetch(`${BENCH_API}/api/providers`);
      const json = await responseJson(response);
      // A few dev/test proxies return a generic 200 payload for unknown API
      // routes. Treat that as the pre-provider local default; a real provider
      // API always includes the providers array, including when it is empty.
      setProviders(Array.isArray(json.providers) ? json.providers : [compatibilityLocalProvider]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setProvidersLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  async function saveProvider(input: ProviderInput, id?: string) {
    const response = await fetch(
      id ? `${BENCH_API}/api/providers/${encodeURIComponent(id)}` : `${BENCH_API}/api/providers`,
      {
        method: id ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      }
    );
    const json = await responseJson(response);
    const provider = json.provider as ProviderConfig;
    setProviders((previous) => {
      const existingIndex = previous.findIndex((candidate) => candidate.id === provider.id);
      if (existingIndex === -1) return [...previous, provider];
      return previous.map((candidate) => candidate.id === provider.id ? provider : candidate);
    });
    return provider;
  }

  async function deleteProvider(id: string) {
    const response = await fetch(`${BENCH_API}/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    await responseJson(response);
    setProviders((previous) => previous.filter((candidate) => candidate.id !== id));
  }

  return { providers, providersLoading, refreshProviders, saveProvider, deleteProvider };
}
