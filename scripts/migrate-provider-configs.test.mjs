// @vitest-environment node
import { describe, expect, it } from "vitest";
import { migrateRunProvider } from "./migrate-provider-configs.mjs";

const providers = [
  { id: "local", name: "oMLX", baseUrl: "http://localhost:8000/v1" },
  { id: "vlm", name: "VLM", baseUrl: "https://api.vlm.run/v1/openai" }
];

describe("provider config migration", () => {
  it("maps exact provider URLs and preserves the historical endpoint", () => {
    const original = {
      id: "run-1",
      model: "model",
      baseUrl: "http://localhost:8000/v1",
      config: { baseUrl: "http://localhost:8000/v1", apiKey: "" }
    };

    const result = migrateRunProvider(original, providers);

    expect(result).toMatchObject({ changed: true, matchType: "exact", provider: { id: "local" } });
    expect(result.run).toMatchObject({
      baseUrl: original.baseUrl,
      providerId: "local",
      providerName: "oMLX",
      config: { baseUrl: original.baseUrl, providerId: "local", providerName: "oMLX" }
    });
  });

  it("supports explicit endpoint aliases and redacts legacy plaintext keys", () => {
    const oldUrl = "https://gateway.vlm.run/v1/openai";
    const result = migrateRunProvider({
      id: "run-2",
      baseUrl: oldUrl,
      config: { baseUrl: oldUrl, apiKey: "sk-legacy" }
    }, providers, new Map([[oldUrl, "vlm"]]));

    expect(result).toMatchObject({ changed: true, matchType: "alias", redactedKeys: 1 });
    expect(result.run.config).toMatchObject({ providerId: "vlm", providerName: "VLM", apiKey: "***" });
    expect(result.run.baseUrl).toBe(oldUrl);
  });

  it("uses an explicit alias to correct a previous provider assignment", () => {
    const oldUrl = "https://gateway.vlm.run/v1/openai";
    const gateway = { id: "vlm-gateway", name: "VLM Gateway", baseUrl: oldUrl };
    const result = migrateRunProvider({
      id: "run-2b",
      providerId: "vlm",
      providerName: "VLM",
      baseUrl: oldUrl,
      config: { providerId: "vlm", providerName: "VLM", baseUrl: oldUrl }
    }, [...providers, gateway], new Map([[oldUrl, gateway.id]]));

    expect(result).toMatchObject({ changed: true, matchType: "alias", provider: gateway });
    expect(result.run).toMatchObject({
      providerId: gateway.id,
      providerName: gateway.name,
      config: { providerId: gateway.id, providerName: gateway.name }
    });
  });

  it("leaves unmatched endpoints unmapped", () => {
    const result = migrateRunProvider({
      id: "run-3",
      baseUrl: "http://localhost:1234/v1",
      config: { baseUrl: "http://localhost:1234/v1" }
    }, providers);

    expect(result).toMatchObject({ changed: false, provider: null, matchType: null });
    expect(result.run.providerId).toBeUndefined();
  });
});
