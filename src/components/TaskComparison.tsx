import { ArrowDownUp, ArrowLeft, ArrowRight, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BENCH_API, runBenchmarkId, type BenchResult, type BenchRun } from "../domain/benchmark";
import { formatAssert, formatDuration, pct, resultScore } from "../domain/runs";
import type { ComparisonRow } from "./BenchmarkComparison";

type TaskRunResults = {
  run: BenchRun;
  results: BenchResult[];
  score: number;
};

export type TaskComparisonRow = {
  key: string;
  benchmarkId: string;
  taskId: string;
  index: number;
  prompt: string;
  resultsByRunId: Map<string, TaskRunResults>;
  spread: number;
};

function selectedRuns(rows: ComparisonRow[]) {
  const runsById = new Map<string, BenchRun>();
  rows.forEach((row) => row.cells.forEach(({ run }) => runsById.set(run.id, run)));
  return [...runsById.values()];
}

export function buildTaskComparisonRows(runs: BenchRun[]) {
  const taskRows = new Map<string, TaskComparisonRow>();
  for (const run of runs) {
    const benchmarkId = runBenchmarkId(run);
    for (const result of run.results) {
      const key = `${benchmarkId}\u0000${result.taskId}`;
      const taskRow = taskRows.get(key) ?? {
        key,
        benchmarkId,
        taskId: result.taskId,
        index: result.index,
        prompt: result.prompt,
        resultsByRunId: new Map<string, TaskRunResults>(),
        spread: 0
      };
      const runResults = taskRow.resultsByRunId.get(run.id) ?? { run, results: [], score: 0 };
      runResults.results.push(result);
      runResults.score = runResults.results.reduce((totalScore, runResult) => totalScore + resultScore(runResult), 0)
        / runResults.results.length;
      taskRow.resultsByRunId.set(run.id, runResults);
      taskRows.set(key, taskRow);
    }
  }
  return [...taskRows.values()].map((taskRow) => {
    const scores = [...taskRow.resultsByRunId.values()].map(({ score }) => score);
    return {
      ...taskRow,
      spread: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0
    };
  });
}

function RunHeading({
  run,
  runIndex,
  runCount,
  moveRun
}: {
  run: BenchRun;
  runIndex: number;
  runCount: number;
  moveRun: (runId: string, direction: -1 | 1) => void;
}) {
  return (
    <div className="task-comparison-run-heading">
      <div>
        <strong>{run.model || "Unknown model"}</strong>
        <span className="task-comparison-column-controls">
          <button aria-label={`Move ${run.model} left`} disabled={runIndex === 0} title="Move column left" type="button" onClick={() => moveRun(run.id, -1)}><ArrowLeft size={13} /></button>
          <button aria-label={`Move ${run.model} right`} disabled={runIndex === runCount - 1} title="Move column right" type="button" onClick={() => moveRun(run.id, 1)}><ArrowRight size={13} /></button>
        </span>
      </div>
      <span>{run.providerName || run.config?.providerName || run.providerId || "Unknown provider"}</span>
      <small>{run.config?.thinkingEnabled === false ? "Thinking off" : `${run.config?.thinkingBudget ?? "?"} thinking tokens`}</small>
    </div>
  );
}

function TaskImages({ result }: { result: BenchResult }) {
  if (!result.images?.length) return null;
  return (
    <div className="task-comparison-images">
      {result.images.map((image, imageIndex) => (
        <figure key={image.file}>
          <a href={`${BENCH_API}${image.url}`} rel="noreferrer" target="_blank">
            <img alt={`Photograph ${imageIndex + 1} sent to the models`} loading="lazy" src={`${BENCH_API}${image.url}`} />
          </a>
          {image.profileUrl ? (
            <figcaption><a href={image.profileUrl} rel="noreferrer" target="_blank"><ExternalLink size={12} />View profile</a></figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  );
}

function ResultDetails({ result }: { result: BenchResult }) {
  const passedChecks = result.tests.filter((test) => test.passed).length;
  const durationMilliseconds = result.activeDurationMilliseconds ?? result.generationMs;
  return (
    <article className="task-comparison-attempt">
      <header>
        <span className={result.passed ? "pass-pill" : resultScore(result) > 0 ? "partial-pill" : "fail-pill"}>
          {result.passed ? "pass" : resultScore(result) > 0 ? "partial" : "fail"}
        </span>
        <strong>{pct(resultScore(result))}</strong>
        <small>Pass {result.passNumber ?? 1} · {passedChecks}/{result.tests.length} checks{durationMilliseconds ? ` · ${formatDuration(durationMilliseconds)}` : ""}</small>
      </header>
      <details open><summary>Scoring</summary>{result.tests.length ? result.tests.map((test, testIndex) => <pre className={test.passed ? "assert-pass" : "assert-fail"} key={testIndex}>{formatAssert(test)}</pre>) : <pre>No checks recorded.</pre>}</details>
      <details><summary>Thinking</summary><pre>{result.thinkingOutput || "No separate thinking stream captured."}</pre></details>
      <details><summary>Raw output</summary><pre>{result.rawOutput || "No output captured."}</pre></details>
      <details><summary>Extracted answer</summary><pre>{result.extractedCode || "No answer extracted."}</pre></details>
      <details><summary>Expected answer / tests</summary><pre>{result.test || result.expectedAnswer || "No reference recorded."}</pre></details>
      {result.modelError || result.traceback || result.error || result.harnessStderr ? <details open><summary>Error / harness</summary><pre className="harness-error">{result.modelError || result.traceback || result.error || result.harnessStderr}</pre></details> : null}
    </article>
  );
}

export function TaskComparison({
  rows,
  fullScreen,
  setFullScreen
}: {
  rows: ComparisonRow[];
  fullScreen: boolean;
  setFullScreen: (fullScreen: boolean) => void;
}) {
  const [sortBySpread, setSortBySpread] = useState(true);
  const [runOrder, setRunOrder] = useState<string[]>([]);
  const [taskScoreSort, setTaskScoreSort] = useState<{ taskKey: string; descending: boolean } | null>(null);
  const selectedRunSummaries = useMemo(() => selectedRuns(rows), [rows]);
  const selectedRunIds = selectedRunSummaries.map((run) => run.id).join("\u0000");
  const [loadedRuns, setLoadedRuns] = useState<BenchRun[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();
    setLoadedRuns([]);
    setLoading(true);
    setLoadError("");
    Promise.all(selectedRunSummaries.map(async (run) => {
      if (run.results.length) return run;
      const response = await fetch(`${BENCH_API}/api/runs/${encodeURIComponent(run.id)}`, { signal: abortController.signal });
      if (!response.ok) throw new Error(`Could not load ${run.model || run.id} (${response.status})`);
      return response.json() as Promise<BenchRun>;
    }))
      .then((nextRuns) => setLoadedRuns(nextRuns))
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) setLoadError(error instanceof Error ? error.message : "Could not load task results.");
      })
      .finally(() => {
        if (!abortController.signal.aborted) setLoading(false);
      });
    return () => abortController.abort();
  }, [selectedRunIds]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    const exitFullScreen = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", exitFullScreen);
    return () => window.removeEventListener("keydown", exitFullScreen);
  }, [fullScreen, setFullScreen]);

  const unorderedRuns = loadedRuns.length ? loadedRuns : selectedRunSummaries;
  const runs = useMemo(() => {
    if (!runOrder.length) return unorderedRuns;
    const positions = new Map(runOrder.map((runId, runIndex) => [runId, runIndex]));
    return [...unorderedRuns].sort((left, right) => (
      (positions.get(left.id) ?? runOrder.length + unorderedRuns.indexOf(left))
      - (positions.get(right.id) ?? runOrder.length + unorderedRuns.indexOf(right))
    ));
  }, [runOrder, unorderedRuns]);
  const taskRows = useMemo(() => buildTaskComparisonRows(runs).sort((left, right) => (
    sortBySpread
      ? right.spread - left.spread || left.benchmarkId.localeCompare(right.benchmarkId) || left.index - right.index
      : left.benchmarkId.localeCompare(right.benchmarkId) || left.index - right.index
  )), [runs, sortBySpread]);

  function moveRun(runId: string, direction: -1 | 1) {
    const nextRuns = [...runs];
    const currentIndex = nextRuns.findIndex((run) => run.id === runId);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= nextRuns.length) return;
    [nextRuns[currentIndex], nextRuns[nextIndex]] = [nextRuns[nextIndex], nextRuns[currentIndex]];
    setRunOrder(nextRuns.map((run) => run.id));
    setTaskScoreSort(null);
  }

  function sortRunsByTaskScore(taskRow: TaskComparisonRow) {
    const descending = taskScoreSort?.taskKey === taskRow.key ? !taskScoreSort.descending : true;
    const nextRuns = [...runs].sort((left, right) => {
      const leftScore = taskRow.resultsByRunId.get(left.id)?.score;
      const rightScore = taskRow.resultsByRunId.get(right.id)?.score;
      if (leftScore === undefined) return rightScore === undefined ? 0 : 1;
      if (rightScore === undefined) return -1;
      return descending ? rightScore - leftScore : leftScore - rightScore;
    });
    setRunOrder(nextRuns.map((run) => run.id));
    setTaskScoreSort({ taskKey: taskRow.key, descending });
  }

  return (
    <section className="task-comparison-panel">
      <div className="task-comparison-toolbar">
        <span>{loading ? "Loading task results…" : `${taskRows.length} tasks across ${runs.length} runs`}</span>
        <div className="task-comparison-toolbar-actions">
          <label><input checked={sortBySpread} type="checkbox" onChange={(event) => setSortBySpread(event.target.checked)} />Sort by score spread</label>
          <button
            aria-label={fullScreen ? "Exit full screen" : "Enter full screen"}
            title={fullScreen ? "Exit full screen" : "Full screen"}
            type="button"
            onClick={() => setFullScreen(!fullScreen)}
          >{fullScreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        </div>
      </div>
      {loadError ? <p className="task-comparison-error">{loadError}</p> : null}
      <div className="task-comparison-scroll">
        <div className="task-comparison-grid" style={{ gridTemplateColumns: `140px repeat(${runs.length}, 360px)` }}>
          <div className="task-comparison-corner">Task / spread</div>
          {runs.map((run, runIndex) => <RunHeading key={run.id} moveRun={moveRun} run={run} runCount={runs.length} runIndex={runIndex} />)}
          {taskRows.map((taskRow) => {
            const representativeResult = [...taskRow.resultsByRunId.values()][0]?.results[0];
            return (
              <div className="task-comparison-group" key={taskRow.key} style={{ gridColumn: `1 / span ${runs.length + 1}` }}>
                <header className="task-comparison-task-header">
                  <div><strong>{taskRow.taskId}</strong><span>{taskRow.benchmarkId} · spread {pct(taskRow.spread)}</span></div>
                  {representativeResult ? <TaskImages result={representativeResult} /> : null}
                  <details><summary>Task input</summary><pre>{taskRow.prompt || "No task input recorded."}</pre></details>
                </header>
                <div className="task-comparison-result-row" style={{ gridTemplateColumns: `140px repeat(${runs.length}, 360px)` }}>
                  <div className="task-comparison-spread">
                    <strong>{pct(taskRow.spread)}</strong><span>spread</span>
                    <button
                      aria-label={`Sort columns by ${taskRow.taskId} score ${taskScoreSort?.taskKey === taskRow.key && taskScoreSort.descending ? "ascending" : "descending"}`}
                      className={taskScoreSort?.taskKey === taskRow.key ? "active" : ""}
                      title="Sort columns by this task's score"
                      type="button"
                      onClick={() => sortRunsByTaskScore(taskRow)}
                    ><ArrowDownUp size={14} /></button>
                  </div>
                  {runs.map((run) => {
                    const runResults = taskRow.resultsByRunId.get(run.id);
                    return <div className="task-comparison-cell" key={run.id}>{runResults ? runResults.results.map((result, resultIndex) => <ResultDetails key={`${result.attemptId ?? result.passNumber ?? resultIndex}`} result={result} />) : <span className="comparison-empty">Not run</span>}</div>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {!taskRows.length ? <p className="comparison-empty-state">No task results match these filters.</p> : null}
      </div>
    </section>
  );
}