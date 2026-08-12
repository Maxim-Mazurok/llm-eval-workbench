import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createCredentialStore } from "./credentialStore.mjs";
import { normalizeBaseUrl } from "./domain.mjs";

export const DEFAULT_PROVIDER = Object.freeze({
  id: "local-default",
  name: "Local model server",
  baseUrl: "http://localhost:8000/v1"
});

function cleanProvider(input, id = randomUUID()) {
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Provider name is required.");
  return {
    id,
    name,
    baseUrl: normalizeBaseUrl(input?.baseUrl),
    createdAt: input?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function createProviderStore({
  configDir,
  credentialStore,
  seedDefault = true
}) {
  const providersFile = join(configDir, "providers.json");
  let storePromise = null;
  let credentials = credentialStore;

  async function credentialBackend() {
    credentials ??= createCredentialStore();
    return credentials;
  }

  async function writeProviders(providers) {
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    const temporaryFile = `${providersFile}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporaryFile, 0o600).catch(() => undefined);
    await fs.rename(temporaryFile, providersFile);
  }

  async function readProviders() {
    try {
      const parsed = JSON.parse(await fs.readFile(providersFile, "utf8"));
      return Array.isArray(parsed?.providers) ? parsed.providers : [];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!seedDefault) return [];
      const provider = cleanProvider(DEFAULT_PROVIDER, DEFAULT_PROVIDER.id);
      await writeProviders([provider]);
      return [provider];
    }
  }

  function state() {
    storePromise ??= readProviders();
    return storePromise;
  }

  async function publicProvider(provider) {
    let hasApiKey = false;
    try {
      hasApiKey = Boolean(await (await credentialBackend()).load(provider.id));
    } catch {
      // Listing metadata must still work if the OS keyring is unavailable.
    }
    return { ...provider, hasApiKey };
  }

  async function list() {
    return Promise.all((await state()).map(publicProvider));
  }

  async function get(id) {
    const provider = (await state()).find((candidate) => candidate.id === id);
    return provider ? publicProvider(provider) : null;
  }

  async function resolve(id) {
    const provider = (await state()).find((candidate) => candidate.id === id);
    if (!provider) throw new Error("Saved provider not found. Choose another provider or create it again.");
    let apiKey = "";
    try {
      apiKey = await (await credentialBackend()).load(provider.id) || "";
    } catch (error) {
      throw new Error(`Could not read the saved API key: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...provider, apiKey };
  }

  async function save(input, requestedId) {
    const providers = await state();
    const existingIndex = requestedId
      ? providers.findIndex((candidate) => candidate.id === requestedId)
      : -1;
    if (requestedId && existingIndex === -1) throw new Error("Provider not found.");
    const existing = existingIndex >= 0 ? providers[existingIndex] : null;
    const provider = cleanProvider({ ...existing, ...input }, existing?.id || requestedId || randomUUID());
    const duplicate = providers.find((candidate) => (
      candidate.id !== provider.id && candidate.name.toLocaleLowerCase() === provider.name.toLocaleLowerCase()
    ));
    if (duplicate) throw new Error(`A provider named "${provider.name}" already exists.`);

    if (Object.hasOwn(input, "apiKey")) {
      const apiKey = String(input.apiKey || "").trim();
      const backend = await credentialBackend();
      if (apiKey) await backend.save(provider.id, apiKey);
      else await backend.clear(provider.id);
    }

    const nextProviders = [...providers];
    if (existingIndex >= 0) nextProviders[existingIndex] = provider;
    else nextProviders.push(provider);
    await writeProviders(nextProviders);
    storePromise = Promise.resolve(nextProviders);
    return publicProvider(provider);
  }

  async function remove(id) {
    const providers = await state();
    if (!providers.some((candidate) => candidate.id === id)) return false;
    try {
      await (await credentialBackend()).clear(id);
    } catch {
      // A keyless profile must remain manageable on a headless Linux machine
      // without Secret Service. If a previously available vault went away,
      // this can leave an unreachable orphan credential, but never plaintext
      // metadata or a credential the app can still resolve.
    }
    const nextProviders = providers.filter((candidate) => candidate.id !== id);
    await writeProviders(nextProviders);
    storePromise = Promise.resolve(nextProviders);
    return true;
  }

  return { providersFile, list, get, resolve, save, remove };
}
