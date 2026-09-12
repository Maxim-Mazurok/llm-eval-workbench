import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractCodeFromOutput } from "./server/domain.mjs";
import { executeTests } from "./server/testHarness.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), "..");

export function legacyExtractCode(response, prompt) {
  const text = String(response || "").trim();
  const pythonBlocks = [...text.matchAll(/```python\s*\n([\s\S]*?)```/gi)];
  if (pythonBlocks.length) {
    const code = pythonBlocks[pythonBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  const genericBlocks = [...text.matchAll(/```\s*\n([\s\S]*?)```/g)];
  if (genericBlocks.length) {
    const code = genericBlocks[genericBlocks.length - 1][1].trim();
    return code.includes("def ") ? code : prompt + code;
  }
  if (text.startsWith("def ") || text.startsWith("import ") || text.startsWith("from ")) return text;
  return prompt + text;
}

export function storedResultStatus(result) {
  if (result.passed) return "pass";
  return Array.isArray(result.tests) && result.tests.length > 0 ? "fail" : "error";
}

export function extractionChangeCause(result, outputOnlyCode) {
  const storedCode = String(result.extractedCode ?? "");
  const prompt = String(result.prompt ?? "");
  const rawOutput = String(result.rawOutput ?? "");
  const rawTranscript = typeof result.rawTranscript === "string" ? result.rawTranscript : "";
  const thinking = typeof result.thinkingOutput === "string" ? result.thinkingOutput : "";
  const causes = [];

  if (rawTranscript && rawTranscript !== rawOutput && storedCode === legacyExtractCode(rawTranscript, prompt)) {
    causes.push("legacy transcript extraction");
  }
  if (storedCode === legacyExtractCode(rawOutput, prompt) && storedCode !== outputOnlyCode) {
    causes.push("legacy output fence parsing");
  }
  if (thinking && hasThinkingOnlyOverlap(storedCode, rawOutput, thinking)) {
    causes.push("thinking text present in stored code");
  }
  if (!causes.length) causes.push("stored extraction differs from current output-only extraction");
  return causes;
}

function hasThinkingOnlyOverlap(storedCode, rawOutput, thinking) {
  const evidenceLines = [...new Set(thinking
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24 && !rawOutput.includes(line)))];
  return evidenceLines.some((line) => storedCode.includes(line));
}

export function codeFingerprint(code) {
  return createHash("sha256").update(String(code)).digest("hex").slice(0, 12);
}

export async function discoverSavedRuns(runsDir, { benchmarkIds = ["humaneval"] } = {}) {
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(runsDir, entry.name);
    try {
      const [runText, resultsText] = await Promise.all([
        fs.readFile(join(directory, "run.json"), "utf8"),
        fs.readFile(join(directory, "results.json"), "utf8")
      ]);
      const run = JSON.parse(runText);
      const results = JSON.parse(resultsText);
      if (!Array.isArray(results)) throw new Error("results.json is not an array");
      const benchmark = run?.benchmark ?? run?.config?.benchmark ?? "humaneval";
      if (benchmarkIds && !benchmarkIds.includes(benchmark)) continue;
      runs.push({ directory, directoryName: entry.name, run, results });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      runs.push({
        directory,
        directoryName: entry.name,
        run: null,
        results: [],
        loadError: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return runs.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

export async function reprocessArchive({
  runsDir,
  executeCandidate = executeHumanEvalCandidate,
  concurrency = 4,
  timeoutSeconds,
  execute = true,
  onProgress
}) {
  const savedRuns = await discoverSavedRuns(runsDir);
  const runReports = [];
  const pending = [];

  for (const savedRun of savedRuns) {
    if (savedRun.loadError) {
      runReports.push({
        directoryName: savedRun.directoryName,
        id: null,
        model: null,
        loadError: savedRun.loadError,
        total: 0,
        plannedTotal: 0,
        eligible: 0,
        withThinking: 0,
        changedExtractions: 0,
        oldPassed: 0,
        newPassed: 0,
        affected: []
      });
      continue;
    }

    const { run, results } = savedRun;
    const configuredPasses = Math.max(
      1,
      Number(run.config?.passCount) || 1,
      ...results.map((result) => Number(result.passTotal || result.passNumber || 1)).filter(Number.isFinite)
    );
    const plannedAttempts = Number(run.total) || results.length;
    const plannedPerPass = Math.max(1, Math.ceil(plannedAttempts / configuredPasses));
    const passMap = new Map();
    for (const result of results) {
      const passNumber = Math.max(1, Number(result.passNumber || 1));
      const pass = passMap.get(passNumber) || {
        passNumber,
        total: 0,
        plannedTotal: plannedPerPass,
        oldPassed: 0,
        newPassed: 0,
        changedExtractions: 0
      };
      pass.total += 1;
      if (result.passed) {
        pass.oldPassed += 1;
        pass.newPassed += 1;
      }
      passMap.set(passNumber, pass);
    }
    const report = {
      directoryName: savedRun.directoryName,
      id: String(run.id || savedRun.directoryName),
      model: String(run.model || run.config?.model || "unknown"),
      status: String(run.status || "unknown"),
      total: results.length,
      plannedTotal: plannedAttempts,
      eligible: 0,
      withThinking: 0,
      changedExtractions: 0,
      oldPassed: results.filter((result) => result.passed).length,
      newPassed: results.filter((result) => result.passed).length,
      passes: [...passMap.values()].sort((left, right) => left.passNumber - right.passNumber),
      affected: []
    };

    results.forEach((result, resultIndex) => {
      if (result.modelError || typeof result.rawOutput !== "string" || typeof result.prompt !== "string") return;
      report.eligible += 1;
      if (typeof result.thinkingOutput === "string" && result.thinkingOutput.length > 0) report.withThinking += 1;
      const outputOnlyCode = extractCodeFromOutput(result.rawOutput, result.prompt);
      const storedCode = String(result.extractedCode ?? "");
      if (outputOnlyCode === storedCode) return;

      report.changedExtractions += 1;
      passMap.get(Math.max(1, Number(result.passNumber || 1))).changedExtractions += 1;
      const affected = {
        taskId: String(result.taskId || `result-${resultIndex}`),
        index: Number.isFinite(Number(result.index)) ? Number(result.index) : null,
        passNumber: Number(result.passNumber || 1),
        hadThinking: typeof result.thinkingOutput === "string" && result.thinkingOutput.length > 0,
        causes: extractionChangeCause(result, outputOnlyCode),
        oldCodeHash: codeFingerprint(storedCode),
        newCodeHash: codeFingerprint(outputOnlyCode),
        oldStatus: storedResultStatus(result),
        newStatus: execute ? "pending" : "not rerun",
        runnerError: null
      };
      report.affected.push(affected);
      if (execute) {
        const configuredTimeout = Number(timeoutSeconds ?? run.config?.timeoutSeconds ?? 15);
        pending.push({
          report,
          affected,
          problem: {
            task_id: result.taskId,
            entry_point: result.entryPoint,
            test: result.test
          },
          code: outputOnlyCode,
          timeoutSeconds: Number.isFinite(configuredTimeout) ? Math.min(120, Math.max(1, configuredTimeout)) : 15
        });
      }
    });
    runReports.push(report);
  }

  if (execute) {
    let rerunCompleted = 0;
    await mapConcurrent(pending, concurrency, async (item) => {
      try {
        const rerun = await executeCandidate(item.problem, item.code, item.timeoutSeconds);
        item.affected.newStatus = rerun.status;
        item.affected.runnerError = rerun.error || null;
        if (item.affected.oldStatus === "pass") item.report.newPassed -= 1;
        if (rerun.status === "pass") item.report.newPassed += 1;
        const pass = item.report.passes.find((candidate) => candidate.passNumber === item.affected.passNumber);
        if (pass) {
          if (item.affected.oldStatus === "pass") pass.newPassed -= 1;
          if (rerun.status === "pass") pass.newPassed += 1;
        }
      } catch (error) {
        item.affected.newStatus = "error";
        item.affected.runnerError = error instanceof Error ? error.message : String(error);
        if (item.affected.oldStatus === "pass") item.report.newPassed -= 1;
        const pass = item.report.passes.find((candidate) => candidate.passNumber === item.affected.passNumber);
        if (pass && item.affected.oldStatus === "pass") pass.newPassed -= 1;
      }
      rerunCompleted += 1;
      onProgress?.({ completed: rerunCompleted, total: pending.length, item });
    });
  }

  return summarizeArchive(runReports, { execute, runsDir });
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

function summarizeArchive(runs, { execute, runsDir }) {
  const validRuns = runs.filter((run) => !run.loadError);
  const affected = validRuns.flatMap((run) => run.affected.map((result) => ({ ...result, runId: run.id, model: run.model })));
  const transitions = {};
  const causes = {};
  for (const result of affected) {
    const transition = `${result.oldStatus} -> ${result.newStatus}`;
    transitions[transition] = (transitions[transition] || 0) + 1;
    for (const cause of result.causes) causes[cause] = (causes[cause] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: execute ? "re-executed changed extractions" : "extraction comparison only",
    runsDir,
    totals: {
      runDirectories: runs.length,
      loadErrors: runs.filter((run) => run.loadError).length,
      results: validRuns.reduce((sum, run) => sum + run.total, 0),
      eligible: validRuns.reduce((sum, run) => sum + run.eligible, 0),
      withThinking: validRuns.reduce((sum, run) => sum + run.withThinking, 0),
      changedExtractions: affected.length,
      affectedRuns: validRuns.filter((run) => run.changedExtractions > 0).length,
      oldPassed: validRuns.reduce((sum, run) => sum + run.oldPassed, 0),
      newPassed: validRuns.reduce((sum, run) => sum + run.newPassed, 0)
    },
    transitions,
    causes,
    runs
  };
}

export async function executeHumanEvalCandidate(problem, code, timeoutSeconds = 15) {
  if (!problem?.entry_point || typeof problem.test !== "string") {
    return { status: "error", error: "Stored result is missing entryPoint or test code" };
  }
  const result = await executeTests(problem, code, timeoutSeconds);
  return {
    status: result.passed ? "pass" : result.tests?.length ? "fail" : "error",
    error: result.error ? errorKind(result) : null
  };
}

function errorKind(result) {
  if (result.timeout) return "Execution timed out";
  const tracebackLine = String(result.traceback || "").trim().split("\n").pop();
  return tracebackLine?.match(/^([A-Za-z][A-Za-z0-9_.]*Error|[A-Za-z][A-Za-z0-9_.]*Exception)\b/)?.[1]
    || "Harness error";
}

function directPythonHarness(userCode, testCode, entryPoint) {
  return `
import contextlib, io, json, os, traceback
USER_CODE = ${JSON.stringify(userCode)}
TEST_CODE = ${JSON.stringify(testCode)}
ENTRY_POINT = ${JSON.stringify(entryPoint)}

def reliability_guard():
    import builtins, shutil, subprocess
    builtins.exit = None
    builtins.quit = None
    os.kill = None
    os.system = None
    os.remove = None
    os.removedirs = None
    os.rmdir = None
    os.rename = None
    os.renames = None
    os.truncate = None
    os.replace = None
    os.unlink = None
    shutil.rmtree = None
    shutil.move = None
    subprocess.Popen = None

def emit(status, error=None):
    print(json.dumps({"status": status, "error": error}))

reliability_guard()
ns = {}
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        exec(USER_CODE, ns)
        candidate = ns[ENTRY_POINT]
except BaseException as exc:
    emit("error", type(exc).__name__)
else:
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            exec(TEST_CODE, ns)
    except BaseException as exc:
        emit("error", f"test setup: {type(exc).__name__}")
    else:
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                ns["check"](candidate)
        except BaseException as exc:
            emit("fail", type(exc).__name__)
        else:
            emit("pass")
`;
}

export function markdownReport(report) {
  const totals = report.totals;
  const delta = totals.newPassed - totals.oldPassed;
  const changedRuns = report.runs.filter((run) => run.changedExtractions > 0);
  const lines = [
    "# Output-only extraction reprocessing report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "This audit is non-destructive. Saved `run.json`, `results.json`, task logs, and `RESULTS.md` were not modified. Candidate code and model reasoning are intentionally omitted; hashes identify extraction changes without exposing sensitive content.",
    "",
    "## Executive summary",
    "",
    `- Run directories scanned: ${totals.runDirectories}`,
    `- Stored attempts scanned: ${totals.results}`,
    `- Attempts with enough saved output to re-extract: ${totals.eligible}`,
    `- Attempts with non-empty separate thinking: ${totals.withThinking}`,
    `- Attempts whose stored code differs from output-only extraction: ${totals.changedExtractions}`,
    `- Runs containing extraction changes: ${totals.affectedRuns}`,
    `- Aggregate passes: ${totals.oldPassed} -> ${totals.newPassed} (${formatSigned(delta)})`,
    `- Artifact load errors: ${totals.loadErrors}`,
    "",
    "## Status transitions",
    "",
    ...objectSummaryLines(report.transitions),
    "",
    "## Extraction-change diagnoses",
    "",
    ...objectSummaryLines(report.causes),
    "",
    "A diagnosis can have more than one label. `legacy transcript extraction` is direct evidence that the stored code matches extraction from the combined transcript rather than the separate output. `thinking text present in stored code` means a line unique to the thinking stream appears in the stored candidate. `legacy output fence parsing` identifies output-only candidates changed by the unterminated-fence fix.",
    "",
    "## Run-level score changes",
    "",
    "| Run | Model | Attempts | Thinking | Extractions changed | Old score | New score | Delta |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.runs.map((run) => {
      if (run.loadError) return `| ${escapeCell(run.directoryName)} | load error | 0 | 0 | 0 | n/a | n/a | n/a |`;
      const oldScore = score(run.oldPassed, run.plannedTotal);
      const newScore = score(run.newPassed, run.plannedTotal);
      return `| ${escapeCell(run.id)} | ${escapeCell(run.model)} | ${run.total}/${run.plannedTotal} | ${run.withThinking} | ${run.changedExtractions} | ${oldScore} | ${newScore} | ${formatSigned(run.newPassed - run.oldPassed)} |`;
    }),
    "",
    "## Pass-level score changes",
    "",
    "Only passes containing extraction changes are listed. This is the relevant view for incomplete multi-pass runs whose headline result records a completed pass.",
    "",
    "| Run | Model | Pass | Attempts | Extractions changed | Old score | New score | Delta |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.runs.flatMap((run) => (run.passes || [])
      .filter((pass) => pass.changedExtractions > 0)
      .map((pass) => `| ${escapeCell(run.id)} | ${escapeCell(run.model)} | ${pass.passNumber} | ${pass.total}/${pass.plannedTotal} | ${pass.changedExtractions} | ${score(pass.oldPassed, pass.plannedTotal)} | ${score(pass.newPassed, pass.plannedTotal)} | ${formatSigned(pass.newPassed - pass.oldPassed)} |`)),
    "",
    "## Affected attempts",
    ""
  ];

  if (!changedRuns.length) {
    lines.push("No stored extraction changed.", "");
  } else {
    for (const run of changedRuns) {
      const passSummary = run.passes
        .filter((pass) => pass.changedExtractions > 0)
        .map((pass) => `pass ${pass.passNumber}: ${score(pass.oldPassed, pass.plannedTotal)} -> ${score(pass.newPassed, pass.plannedTotal)}`)
        .join("; ");
      lines.push(`### ${run.id} — ${run.model}`, "", `Run score: ${score(run.oldPassed, run.plannedTotal)} -> ${score(run.newPassed, run.plannedTotal)}`, "", `Affected pass scores: ${passSummary}`, "", "| Task | Pass | Thinking saved | Diagnosis | Status | Code hashes |", "| --- | ---: | --- | --- | --- | --- |");
      for (const result of run.affected) {
        lines.push(`| ${escapeCell(result.taskId)} | ${result.passNumber} | ${result.hadThinking ? "yes" : "no"} | ${escapeCell(result.causes.join("; "))} | ${result.oldStatus} -> ${result.newStatus} | ${result.oldCodeHash} -> ${result.newCodeHash} |`);
      }
      lines.push("");
    }
  }

  lines.push(
    "## RESULTS.md review guidance",
    "",
    "Compare only run rows above whose pass count changed. Runs with extraction differences but no pass-count delta do not require score edits, though task-specific failure annotations may still need correction when a transition changed category.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function objectSummaryLines(value) {
  const entries = Object.entries(value).sort((left, right) => right[1] - left[1]);
  return entries.length ? entries.map(([label, count]) => `- ${label}: ${count}`) : ["- None"];
}

function score(passed, total) {
  return total ? `${((passed / total) * 100).toFixed(1)}% (${passed}/${total})` : "n/a";
}

function formatSigned(value) {
  return value > 0 ? `+${value}` : String(value);
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(argv) {
  const options = {
    runsDir: join(rootDir, "benchmark-runs"),
    reportPath: join(rootDir, "reports", "output-only-reprocessing.md"),
    jsonPath: join(rootDir, "reports", "output-only-reprocessing.json"),
    concurrency: 4,
    execute: true,
    timeoutSeconds: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--runs-dir") options.runsDir = resolve(argv[++index]);
    else if (argument === "--report") options.reportPath = resolve(argv[++index]);
    else if (argument === "--json") options.jsonPath = resolve(argv[++index]);
    else if (argument === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (argument === "--timeout-seconds") options.timeoutSeconds = Number(argv[++index]);
    else if (argument === "--no-execute") options.execute = false;
    else if (argument === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/reprocess-saved-results.mjs [--runs-dir PATH] [--report PATH] [--json PATH] [--concurrency N] [--timeout-seconds N] [--no-execute]\n");
    return;
  }
  let lastProgress = 0;
  const report = await reprocessArchive({
    ...options,
    onProgress: ({ completed, total }) => {
      if (completed === total || completed - lastProgress >= 25) {
        lastProgress = completed;
        process.stderr.write(`Re-executed ${completed}/${total} changed candidates\n`);
      }
    }
  });
  await Promise.all([
    fs.mkdir(dirname(options.reportPath), { recursive: true }),
    fs.mkdir(dirname(options.jsonPath), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(options.reportPath, markdownReport(report), "utf8"),
    fs.writeFile(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  ]);
  process.stdout.write(`${JSON.stringify({ report: options.reportPath, json: options.jsonPath, totals: report.totals }, null, 2)}\n`);
}

if (resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
