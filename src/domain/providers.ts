import type { BenchRun } from "./benchmark";
import { statusIsLive } from "./runs";

export type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  hasApiKey: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ProviderInput = {
  name: string;
  baseUrl: string;
  apiKey?: string;
};

export function isLocalProviderUrl(baseUrl?: string | null) {
  try {
    const hostname = new URL(String(baseUrl || "")).hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost"
      || hostname === "::1"
      || hostname === "0.0.0.0"
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/** VLM Run's API/agent hosts run Orion; its gateway routes plain inference. */
export function providerKindLabel(baseUrl?: string | null): "Agent" | "Inference" | undefined {
  try {
    const hostname = new URL(String(baseUrl || "")).hostname.toLocaleLowerCase();
    if (hostname === "api.vlm.run" || hostname === "agent.vlm.run") return "Agent";
    if (hostname === "gateway.vlm.run") return "Inference";
  } catch {
    // Invalid URLs are handled by provider validation.
  }
  return undefined;
}

export function providerQueueIsActive(
  runs: BenchRun[],
  selectedProvider?: ProviderConfig | null
) {
  if (!selectedProvider) return false;
  const selectedIsLocal = isLocalProviderUrl(selectedProvider.baseUrl);
  return runs.some((run) => {
    if (!statusIsLive(run.status)) return false;
    if (selectedIsLocal) return isLocalProviderUrl(run.baseUrl ?? run.config?.baseUrl);
    return (run.config?.providerId ?? run.providerId) === selectedProvider.id;
  });
}
