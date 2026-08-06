import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Benchmark packs are optional, self-contained benchmark bundles that live
// outside this repository (typically a private repo cloned or added as a git
// submodule under packs/). A pack directory holds:
//
//   packs/<name>/pack.server.mjs   server entry point — exports `benchmarks`
//   packs/<name>/pack.client.ts    optional frontend entry point — exports
//                                 `benchmarkOptions` (discovered by
//                                 src/domain/benchmarkPacks.ts)
//
// Packs are entirely optional: with none installed the workbench runs the
// built-in benchmarks alone. A pack directory without pack.server.mjs is
// skipped, so an uninitialised git submodule (an empty directory) is not an
// error.

const packsRootDefault = join(dirname(fileURLToPath(import.meta.url)), "../../../packs");

export const SERVER_PACK_ENTRY_POINT = "pack.server.mjs";

export function benchmarkPacksDir() {
  return process.env.BENCHMARK_PACKS_DIR || packsRootDefault;
}

// statSync resolves symlinks, which readdir's Dirent.isDirectory() does not: a pack
// cloned elsewhere and symlinked into packs/ must load exactly like one cloned in place.
function isPackDirectory(packsDir, name) {
  try {
    return statSync(join(packsDir, name)).isDirectory();
  } catch {
    return false;
  }
}

function packDirectoryNames(packsDir) {
  try {
    return readdirSync(packsDir)
      .filter((name) => !name.startsWith(".") && isPackDirectory(packsDir, name))
      .sort();
  } catch {
    return [];
  }
}

function assertPackBenchmarks(name, benchmarks) {
  if (!Array.isArray(benchmarks)) {
    throw new Error(`Benchmark pack "${name}" must export a \`benchmarks\` array.`);
  }
  for (const benchmark of benchmarks) {
    if (!benchmark || typeof benchmark.id !== "string" || !benchmark.id) {
      throw new Error(`Benchmark pack "${name}" exports a benchmark without an id.`);
    }
    for (const method of ["loadProblems", "problemSummary", "problemReference", "extractArtifact", "evaluate"]) {
      if (typeof benchmark[method] !== "function") {
        throw new Error(`Benchmark "${benchmark.id}" in pack "${name}" is missing ${method}().`);
      }
    }
  }
  return benchmarks;
}

/**
 * Import every installed benchmark pack. A pack that exists but fails to load
 * throws — a broken pack must be visible, not silently dropped.
 */
export async function loadBenchmarkPacks(packsDir = benchmarkPacksDir()) {
  const packs = [];
  for (const name of packDirectoryNames(packsDir)) {
    const entryPoint = join(packsDir, name, SERVER_PACK_ENTRY_POINT);
    if (!existsSync(entryPoint)) continue;
    const module = await import(pathToFileURL(entryPoint).href);
    packs.push({
      name,
      label: typeof module.label === "string" ? module.label : name,
      directory: join(packsDir, name),
      benchmarks: assertPackBenchmarks(name, module.benchmarks)
    });
  }
  return packs;
}
