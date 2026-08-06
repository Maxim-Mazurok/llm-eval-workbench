#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBenchmark } from "./server/benchmarks/registry.mjs";
import { executeTests } from "./server/testHarness.mjs";
import { discoverSavedRuns, storedResultStatus } from "./reprocess-saved-results.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), "..");

export async function migrateSavedResults({
  runsDir,
  apply = false,
  backupDir,
  concurrency = 4,
  timeoutSeconds,
  executeTestsFn = executeTests,
  now = () => new Date(),
  onProgress
}) {
  const savedRuns = await discoverSavedRuns(runsDir, { benchmarkIds: null });
  const migrationAt = now().toISOString();
  const resolvedBackupDir = backupDir || join(
    runsDir,
    ".migration-backups",
    `output-only-${migrationAt.replaceAll(":", "-").replaceAll(".", "-")}`
  );
  const jobs = [];
  const runReports = [];

  for (const savedRun of savedRuns) {
    if (savedRun.loadError) {
      runReports.push({ directoryName: savedRun.directoryName, loadError: savedRun.loadError, changed: 0, affected: [] });
      continue;
    }
    const report = {
      directoryName: savedRun.directoryName,
      id: String(savedRun.run.id || savedRun.directoryName),
      model: String(savedRun.run.model || savedRun.run.config?.model || "unknown"),
      status: String(savedRun.run.status || "unknown"),
      oldPassed: savedRun.results.filter((result) => result.passed).length,
      newPassed: savedRun.results.filter((result) => result.passed).length,
      changed: 0,
      affected: [],
      savedRun
    };
    const benchmarkId = savedRun.run.benchmark ?? savedRun.run.config?.benchmark ?? "humaneval";
    const benchmark = getBenchmark(benchmarkId);
    savedRun.results.forEach((result, resultIndex) => {
      if (result.modelError || typeof result.rawOutput !== "string" || typeof result.prompt !== "string") return;
      const problem = storedProblem(result);
      const extractedCode = benchmark.extractArtifact(result.rawOutput, problem);
      if (extractedCode === String(result.extractedCode ?? "")) return;
      const affected = {
        key: resultKey(result),
        taskId: String(result.taskId || `result-${resultIndex}`),
        passNumber: Number(result.passNumber || 1),
        oldStatus: storedResultStatus(result),
        newStatus: "pending"
      };
      report.changed += 1;
      report.affected.push(affected);
      const configuredTimeout = Number(timeoutSeconds ?? savedRun.run.config?.timeoutSeconds ?? 15);
      jobs.push({
        report,
        affected,
        benchmark,
        problem,
        result,
        resultIndex,
        extractedCode,
        timeoutSeconds: Number.isFinite(configuredTimeout) ? Math.min(120, Math.max(1, configuredTimeout)) : 15
      });
    });
    runReports.push(report);
  }

  let completed = 0;
  await mapConcurrent(jobs, concurrency, async (job) => {
    const testResult = job.benchmark.id === "humaneval"
      ? await executeTestsFn(job.problem, job.extractedCode, job.timeoutSeconds)
      : await job.benchmark.evaluate({
        problem: job.problem,
        artifact: job.extractedCode,
        rawOutput: job.result.rawOutput,
        timeoutSeconds: job.timeoutSeconds
      });
    const updatedResult = {
      ...job.result,
      ...testResult,
      passed: Boolean(testResult.passed),
      tests: testResult.tests || [],
      stdout: testResult.stdout || "",
      stderr: testResult.stderr || "",
      harnessStdout: testResult.harnessStdout || "",
      harnessStderr: testResult.harnessStderr || "",
      error: testResult.error || null,
      traceback: testResult.traceback || null,
      timeout: Boolean(testResult.timeout),
      extractedCode: job.extractedCode
    };
    job.report.savedRun.results[job.resultIndex] = updatedResult;
    job.affected.newStatus = storedResultStatus(updatedResult);
    job.affected.updatedResult = updatedResult;
    if (job.result.passed) job.report.newPassed -= 1;
    if (updatedResult.passed) job.report.newPassed += 1;
    completed += 1;
    onProgress?.({ completed, total: jobs.length, job });
  });

  const changedRuns = runReports.filter((report) => report.changed > 0);
  if (apply && changedRuns.length) {
    await fs.mkdir(resolvedBackupDir, { recursive: true });
    for (const report of changedRuns) {
      await persistMigratedRun(report, resolvedBackupDir, migrationAt);
    }
  }

  return {
    generatedAt: migrationAt,
    applied: apply,
    runsDir,
    backupDir: apply && changedRuns.length ? resolvedBackupDir : null,
    totals: {
      runDirectories: savedRuns.length,
      loadErrors: runReports.filter((report) => report.loadError).length,
      changedRuns: changedRuns.length,
      changedResults: jobs.length,
      oldPassed: runReports.reduce((sum, report) => sum + (report.oldPassed || 0), 0),
      newPassed: runReports.reduce((sum, report) => sum + (report.newPassed || 0), 0)
    },
    runs: runReports.map(({ savedRun, ...report }) => ({
      ...report,
      affected: report.affected.map(({ updatedResult, key, ...affected }) => affected)
    }))
  };
}

function storedProblem(result) {
  return {
    task_id: result.taskId,
    entry_point: result.entryPoint,
    test: result.test,
    prompt: result.prompt,
    target: result.expectedAnswer
  };
}

async function persistMigratedRun(report, backupRoot, migrationAt) {
  const { savedRun } = report;
  const backupRunDir = join(backupRoot, savedRun.directoryName);
  await fs.mkdir(backupRunDir, { recursive: true });
  const artifactNames = ["run.json", "results.json", "task-logs.jsonl"];
  await Promise.all(artifactNames.map(async (name) => {
    const source = join(savedRun.directory, name);
    try {
      await fs.copyFile(source, join(backupRunDir, name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));

  const updatedByKey = new Map(report.affected.map((affected) => [affected.key, affected.updatedResult]));
  const runState = derivedRunState(savedRun.run, savedRun.results);
  await Promise.all([
    writeJsonAtomic(join(savedRun.directory, "results.json"), savedRun.results),
    writeJsonAtomic(join(savedRun.directory, "run.json"), runState),
    rewriteJsonLines(join(savedRun.directory, "task-logs.jsonl"), (entry) => updateTaskLogEntry(entry, updatedByKey, migrationAt))
  ]);
}

export function derivedRunState(run, results) {
  const completed = results.length;
  const passed = results.filter((result) => result.passed).length;
  const assertionsTotal = results.reduce((sum, result) => sum + (result.tests?.length || 0), 0);
  const assertionsPassed = results.reduce(
    (sum, result) => sum + (result.tests || []).filter((test) => test.passed).length,
    0
  );
  return {
    ...run,
    completed,
    passed,
    failed: completed - passed,
    liveScore: completed ? passed / completed : 0,
    finalScore: run.total ? passed / run.total : null,
    assertionsPassed,
    assertionsTotal,
    assertionScore: assertionsTotal ? assertionsPassed / assertionsTotal : 0
  };
}

function updateTaskLogEntry(entry, updatedByKey) {
  const result = updatedByKey.get(resultKey(entry));
  if (!result) return entry;
  const updated = { ...entry, passed: result.passed };
  if (entry.channel === "extracted-code") updated.text = result.extractedCode || "";
  if (entry.channel === "harness") {
    const harnessText = result.traceback || result.error || result.harnessStderr || "";
    if (!harnessText) return null;
    updated.text = harnessText;
  }
  return updated;
}

async function rewriteJsonLines(path, transform) {
  let text;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const output = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.push(line);
      continue;
    }
    const updated = transform(parsed);
    if (updated) output.push(JSON.stringify(updated));
  }
  await writeTextAtomic(path, output.length ? `${output.join("\n")}\n` : "");
}

async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path, value) {
  const temporaryPath = `${path}.migrating-${process.pid}`;
  await fs.writeFile(temporaryPath, value, "utf8");
  await fs.rename(temporaryPath, path);
}

function resultKey(value) {
  return value?.attemptId || `${value?.taskId || ""}::pass-${Number(value?.passNumber || 1)}`;
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }));
}

export function migrationMarkdown(report) {
  const changedRuns = report.runs.filter((run) => run.changed > 0);
  const lines = [
    "# Saved benchmark output-only migration",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Mode: ${report.applied ? "applied" : "preview"}`,
    "",
    `Backup: ${report.backupDir || "not created"}`,
    "",
    "## Summary",
    "",
    `- Run directories scanned: ${report.totals.runDirectories}`,
    `- Runs updated: ${report.totals.changedRuns}`,
    `- Results updated: ${report.totals.changedResults}`,
    `- Aggregate passes: ${report.totals.oldPassed} -> ${report.totals.newPassed}`,
    `- Load errors: ${report.totals.loadErrors}`,
    "",
    "## Updated runs",
    "",
    "| Run | Model | Status | Results changed | Passes |",
    "| --- | --- | --- | ---: | ---: |",
    ...changedRuns.map((run) => `| ${run.id} | ${run.model} | ${run.status} | ${run.changed} | ${run.oldPassed} -> ${run.newPassed} |`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const options = {
    runsDir: join(rootDir, "benchmark-runs"),
    reportPath: join(rootDir, "reports", "output-only-migration.md"),
    jsonPath: join(rootDir, "reports", "output-only-migration.json"),
    concurrency: 4,
    apply: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--runs-dir") options.runsDir = resolve(argv[++index]);
    else if (argument === "--backup-dir") options.backupDir = resolve(argv[++index]);
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (argument === "--json") options.jsonPath = resolve(argv[++index]);
    else if (argument === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (argument === "--timeout-seconds") options.timeoutSeconds = Number(argv[++index]);
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/update-saved-results.mjs [--apply] [--runs-dir PATH] [--backup-dir PATH] [--concurrency N] [--timeout-seconds N]\n");
    return;
  }
  let lastProgress = 0;
  const report = await migrateSavedResults({
    ...options,
    onProgress: ({ completed, total }) => {
      if (completed === total || completed - lastProgress >= 25) {
        lastProgress = completed;
        process.stderr.write(`Reprocessed ${completed}/${total} changed results\n`);
      }
    }
  });
  await Promise.all([
    fs.mkdir(dirname(options.reportPath), { recursive: true }),
    fs.mkdir(dirname(options.jsonPath), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(options.reportPath, migrationMarkdown(report), "utf8"),
    fs.writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  ]);
  process.stdout.write(`${JSON.stringify({ report: options.reportPath, json: options.jsonPath, applied: report.applied, backupDir: report.backupDir, totals: report.totals }, null, 2)}\n`);
}

if (resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
