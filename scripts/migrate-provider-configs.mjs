#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeBaseUrl, redactApiKey } from "./server/domain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = process.env.LLM_EVAL_ROOT_DIR || join(__dirname, "..");

function comparableBaseUrl(value) {
  try {
    return normalizeBaseUrl(value).toLocaleLowerCase();
  } catch {
    return "";
  }
}

function redactLegacyKeys(run) {
  let redacted = 0;
  for (const target of [run, run.config, run.publicConfig]) {
    if (!target || typeof target !== "object") continue;
    const value = String(target.apiKey || "").trim();
    if (!value || value === "***") continue;
    target.apiKey = redactApiKey(value, target.baseUrl ?? run.baseUrl);
    redacted += 1;
  }
  return redacted;
}

export function migrateRunProvider(run, providers, aliases = new Map()) {
  const migrated = structuredClone(run);
  const currentProviderId = String(migrated.config?.providerId ?? migrated.providerId ?? "").trim();
  const baseUrl = String(migrated.config?.baseUrl ?? migrated.baseUrl ?? "").trim();
  const normalizedBaseUrl = comparableBaseUrl(baseUrl);
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const aliasProviderId = aliases.get(normalizedBaseUrl);
  let provider = null;
  let matchType = null;

  // An explicit alias is authoritative, including for correcting a previous
  // inferred mapping after a more specific provider is saved later.
  if (aliasProviderId) {
    provider = providerById.get(aliasProviderId);
    if (!provider) throw new Error(`Alias for ${baseUrl} references missing provider ${aliasProviderId}.`);
    matchType = "alias";
  } else if (currentProviderId) {
    provider = providerById.get(currentProviderId);
    matchType = "existing";
  } else {
      const exactMatches = providers.filter((candidate) => comparableBaseUrl(candidate.baseUrl) === normalizedBaseUrl);
      if (exactMatches.length === 1) {
        [provider] = exactMatches;
        matchType = "exact";
      } else if (exactMatches.length > 1) {
        matchType = "ambiguous";
      }
  }

  let changed = false;
  if (provider) {
    migrated.providerId = provider.id;
    migrated.providerName = provider.name;
    migrated.config = {
      ...(migrated.config || {}),
      providerId: provider.id,
      providerName: provider.name
    };
    if (migrated.publicConfig && typeof migrated.publicConfig === "object") {
      migrated.publicConfig.providerId = provider.id;
      migrated.publicConfig.providerName = provider.name;
    }
    changed = currentProviderId !== provider.id
      || migrated.config.providerName !== run.config?.providerName
      || migrated.providerName !== run.providerName;
  }

  const redactedKeys = redactLegacyKeys(migrated);
  changed ||= redactedKeys > 0;
  return {
    run: migrated,
    changed,
    provider,
    matchType,
    redactedKeys,
    baseUrl
  };
}

function parseAliases(args) {
  const aliases = new Map();
  for (const argument of args) {
    if (!argument.startsWith("--alias=")) continue;
    const mapping = argument.slice("--alias=".length);
    const separator = mapping.lastIndexOf("=");
    if (separator <= 0 || separator === mapping.length - 1) {
      throw new Error(`Invalid alias "${argument}". Use --alias=<old-base-url>=<provider-id>.`);
    }
    aliases.set(comparableBaseUrl(mapping.slice(0, separator)), mapping.slice(separator + 1));
  }
  return aliases;
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporaryPath, path);
}

export async function migrateProviderConfigs({ rootDir = defaultRootDir, apply = false, aliases = new Map() } = {}) {
  const providersPath = join(rootDir, ".config", "providers.json");
  const runsDir = join(rootDir, "benchmark-runs");
  const providerPayload = JSON.parse(await fs.readFile(providersPath, "utf8"));
  const providers = Array.isArray(providerPayload.providers) ? providerPayload.providers : [];
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runEntries = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const backupRoot = join(
    runsDir,
    ".provider-migration-backups",
    new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  );
  const summary = {
    total: 0,
    changed: 0,
    mapped: 0,
    alreadyMapped: 0,
    redactedPlaintextKeys: 0,
    providers: {},
    unmatched: {},
    ambiguous: {}
  };

  for (const entry of runEntries) {
    const runPath = join(runsDir, entry.name, "run.json");
    let original;
    try {
      original = JSON.parse(await fs.readFile(runPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    summary.total += 1;
    const result = migrateRunProvider(original, providers, aliases);
    summary.redactedPlaintextKeys += result.redactedKeys;
    if (result.provider) {
      if (result.matchType === "existing") summary.alreadyMapped += 1;
      else summary.mapped += 1;
      const providerSummary = summary.providers[result.provider.name] || { id: result.provider.id, exact: 0, alias: 0, existing: 0 };
      providerSummary[result.matchType] += 1;
      summary.providers[result.provider.name] = providerSummary;
    } else {
      const bucket = result.matchType === "ambiguous" ? summary.ambiguous : summary.unmatched;
      const key = result.baseUrl || "<missing base URL>";
      const endpointSummary = bucket[key] || { count: 0, models: [] };
      endpointSummary.count += 1;
      if (original.model && !endpointSummary.models.includes(original.model)) endpointSummary.models.push(original.model);
      bucket[key] = endpointSummary;
    }
    if (!result.changed) continue;
    summary.changed += 1;
    if (!apply) continue;

    // Backups intentionally redact legacy keys too: a migration that removes
    // plaintext credentials must not create a second plaintext copy.
    const backup = structuredClone(original);
    redactLegacyKeys(backup);
    const backupPath = join(backupRoot, entry.name, "run.json");
    await fs.mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(backupPath, backup);
    await writeJsonAtomic(runPath, result.run);
  }

  return { apply, backupRoot: apply && summary.changed ? backupRoot : null, ...summary };
}

async function main() {
  const args = process.argv.slice(2);
  const summary = await migrateProviderConfigs({
    apply: args.includes("--apply"),
    aliases: parseAliases(args)
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
