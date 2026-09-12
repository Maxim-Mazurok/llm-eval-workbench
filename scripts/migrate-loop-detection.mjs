import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOP_DETECTOR_VERSION,
  reconstructSavedLoopDetection
} from "./server/repetitionDetector.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDirectory = resolve(dirname(scriptPath), "..");

async function writeJsonAtomic(filePath, value) {
  const temporaryFilePath = `${filePath}.migrating-${process.pid}`;
  await fs.writeFile(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryFilePath, filePath);
}

async function readSavedRun(runsDirectory, directoryName) {
  const runDirectory = join(runsDirectory, directoryName);
  const [runText, resultsText] = await Promise.all([
    fs.readFile(join(runDirectory, "run.json"), "utf8"),
    fs.readFile(join(runDirectory, "results.json"), "utf8")
  ]);
  const run = JSON.parse(runText);
  const results = JSON.parse(resultsText);
  if (!Array.isArray(results)) throw new Error("results.json is not an array");
  return { runDirectory, run, results };
}

function clearLegacyLoopClassification(result) {
  const updatedResult = { ...result };
  delete updatedResult.looping;
  delete updatedResult.loopDetection;
  updatedResult.finishReason = null;
  updatedResult.modelError = "Legacy non-contiguous loop classification removed; retry this task to generate a complete result.";
  return updatedResult;
}

export async function migrateLoopDetectionMetadata({
  runsDirectory,
  apply = false,
  backupDirectory,
  runIdentifier,
  now = () => new Date()
}) {
  const migrationTimestamp = now().toISOString();
  const resolvedBackupDirectory = backupDirectory || join(
    runsDirectory,
    ".migration-backups",
    `loop-detection-${migrationTimestamp.replaceAll(":", "-").replaceAll(".", "-")}`
  );
  const entries = await fs.readdir(runsDirectory, { withFileTypes: true });
  const reports = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const savedRun = await readSavedRun(runsDirectory, entry.name);
      const savedRunIdentifier = String(savedRun.run.id || entry.name);
      if (runIdentifier && runIdentifier !== savedRunIdentifier && runIdentifier !== entry.name) continue;

      const affected = [];
      const updatedResults = savedRun.results.map((result, resultIndex) => {
        if (
          result?.looping
          &&
          result.loopDetection?.detectorVersion === LOOP_DETECTOR_VERSION
          && Array.isArray(result.loopDetection.occurrences)
          && result.loopDetection.occurrences.length
        ) return result;
        const reconstructedDetection = reconstructSavedLoopDetection(result);
        if (!reconstructedDetection?.occurrences?.length) {
          if (!result?.looping) return result;
          affected.push({
            taskId: String(result.taskId || `result-${resultIndex}`),
            index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
            action: "cleared",
            occurrences: 0
          });
          return clearLegacyLoopClassification(result);
        }
        const action = result?.looping ? "retained" : "detected";
        affected.push({
          taskId: String(result.taskId || `result-${resultIndex}`),
          index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
          action,
          occurrences: reconstructedDetection.occurrences.length
        });
        return { ...result, looping: true, loopDetection: reconstructedDetection };
      });

      if (apply && affected.length) {
        const backupRunDirectory = join(resolvedBackupDirectory, entry.name);
        await fs.mkdir(backupRunDirectory, { recursive: true });
        await fs.copyFile(
          join(savedRun.runDirectory, "results.json"),
          join(backupRunDirectory, "results.json")
        );
        await writeJsonAtomic(join(savedRun.runDirectory, "results.json"), updatedResults);
      }
      reports.push({
        directoryName: entry.name,
        runIdentifier: savedRunIdentifier,
        model: String(savedRun.run.model || savedRun.run.config?.model || "unknown"),
        changedResults: affected.length,
        retainedResults: affected.filter((result) => result.action === "retained").length,
        detectedResults: affected.filter((result) => result.action === "detected").length,
        clearedResults: affected.filter((result) => result.action === "cleared").length,
        affected
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      reports.push({
        directoryName: entry.name,
        loadError: error instanceof Error ? error.message : String(error),
        changedResults: 0,
        retainedResults: 0,
        detectedResults: 0,
        clearedResults: 0,
        affected: []
      });
    }
  }

  const changedRuns = reports.filter((report) => report.changedResults > 0);
  return {
    generatedAt: migrationTimestamp,
    applied: apply,
    runsDirectory,
    backupDirectory: apply && changedRuns.length ? resolvedBackupDirectory : null,
    totals: {
      runDirectories: reports.length,
      loadErrors: reports.filter((report) => report.loadError).length,
      changedRuns: changedRuns.length,
      changedResults: reports.reduce((total, report) => total + report.changedResults, 0),
      retainedResults: reports.reduce((total, report) => total + report.retainedResults, 0),
      detectedResults: reports.reduce((total, report) => total + report.detectedResults, 0),
      clearedResults: reports.reduce((total, report) => total + report.clearedResults, 0)
    },
    runs: reports
  };
}

function parseArguments(argumentsList) {
  const options = {
    runsDirectory: join(rootDirectory, "benchmark-runs"),
    apply: false
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--runs-directory") options.runsDirectory = resolve(argumentsList[++index]);
    else if (argument === "--backup-directory") options.backupDirectory = resolve(argumentsList[++index]);
    else if (argument === "--run") options.runIdentifier = argumentsList[++index];
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/migrate-loop-detection.mjs [--apply] [--runs-directory PATH] [--backup-directory PATH] [--run ID]\n");
    return;
  }
  const report = await migrateLoopDetectionMetadata(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.totals.loadErrors) process.exitCode = 1;
}

if (resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}