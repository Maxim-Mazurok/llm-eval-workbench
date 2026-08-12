// @vitest-environment node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderStore, DEFAULT_PROVIDER } from "./providerStore.mjs";

const cleanupPaths = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function fixture(seedDefault = true) {
  const configDir = await fs.mkdtemp(join(tmpdir(), "provider-store-"));
  cleanupPaths.push(configDir);
  const secrets = new Map();
  const credentialStore = {
    save: vi.fn(async (account, value) => secrets.set(account, value)),
    load: vi.fn(async (account) => secrets.get(account) ?? null),
    clear: vi.fn(async (account) => secrets.delete(account))
  };
  return {
    configDir,
    credentialStore,
    secrets,
    store: createProviderStore({ configDir, credentialStore, seedDefault })
  };
}

describe("provider store", () => {
  it("seeds a usable local provider without a key", async () => {
    const { store } = await fixture();

    await expect(store.list()).resolves.toMatchObject([{
      id: DEFAULT_PROVIDER.id,
      name: DEFAULT_PROVIDER.name,
      baseUrl: DEFAULT_PROVIDER.baseUrl,
      hasApiKey: false
    }]);
  });

  it("persists metadata but keeps the api key only in the credential store", async () => {
    const { configDir, credentialStore, secrets, store } = await fixture(false);

    const provider = await store.save({
      name: "Azure production",
      baseUrl: "https://example.openai.azure.com/openai/deployments/demo/v1/",
      apiKey: "sk-top-secret"
    });

    expect(provider).toMatchObject({ name: "Azure production", hasApiKey: true });
    expect(credentialStore.save).toHaveBeenCalledWith(provider.id, "sk-top-secret");
    await expect(store.resolve(provider.id)).resolves.toMatchObject({ apiKey: "sk-top-secret" });
    expect(secrets.get(provider.id)).toBe("sk-top-secret");

    const metadata = await fs.readFile(join(configDir, "providers.json"), "utf8");
    expect(metadata).toContain("Azure production");
    expect(metadata).not.toContain("sk-top-secret");
    const mode = (await fs.stat(join(configDir, "providers.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("retains, clears, and deletes a saved key explicitly", async () => {
    const { credentialStore, store } = await fixture(false);
    const created = await store.save({ name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-one" });

    const renamed = await store.save({ name: "OpenAI main", baseUrl: created.baseUrl }, created.id);
    expect(renamed.hasApiKey).toBe(true);
    expect(credentialStore.clear).not.toHaveBeenCalled();

    const cleared = await store.save({ name: renamed.name, baseUrl: renamed.baseUrl, apiKey: "" }, created.id);
    expect(cleared.hasApiKey).toBe(false);
    expect(credentialStore.clear).toHaveBeenCalledWith(created.id);

    await expect(store.remove(created.id)).resolves.toBe(true);
    await expect(store.list()).resolves.toEqual([]);
  });
});

