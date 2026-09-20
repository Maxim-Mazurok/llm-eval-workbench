import { ArrowLeft, BarChart3, Columns3, Repeat2, Table2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { benchmarkOption, runBenchmarkId, type BenchRoute, type BenchRun } from "../domain/benchmark";
import { COMPARISON_METRICS, type ComparisonMetricId } from "../domain/comparisonChart";
import { pct, runMeanScore, runTotal } from "../domain/runs";
import { ComparisonScatterPlot } from "./ComparisonScatterPlot";
import { MultiSelectFilter } from "./MultiSelectFilter";
import { TaskComparison } from "./TaskComparison";

export type ComparisonCell = {
  run: BenchRun;
  score: number;
};

export type ComparisonRow = {
  key: string;
  model: string;
  providers: string[];
  settings: string;
  cells: Map<string, ComparisonCell>;
  averageScore: number;
};

function providerLabel(run: BenchRun) {
  return run.providerName || run.config?.providerName || run.providerId || run.config?.providerId || "Unknown provider";
}

function runSettings(run: BenchRun) {
  const config = run.config ?? {};
  const settings = [
    `${config.maxOutputTokens ?? "?"} output`,
    config.thinkingEnabled === false
      ? "thinking off"
      : `${config.thinkingBudget ?? "?"} thinking${config.forceThinking ? " forced" : ""}`,
    `temperature ${config.temperature ?? 0}`
  ];
  if (config.adaptiveRepetitionPenalty) settings.push("adaptive repetition");
  else if (config.repetitionPenalty !== undefined) settings.push(`repetition ${config.repetitionPenalty}`);
  return settings.join(" · ");
}

function configurationKey(run: BenchRun) {
  const config = run.config ?? {};
  return JSON.stringify({
    model: run.model,
    provider: run.providerId || config.providerId || providerLabel(run),
    maxOutputTokens: config.maxOutputTokens,
    thinkingEnabled: config.thinkingEnabled,
    forceThinking: config.forceThinking,
    thinkingBudget: config.thinkingBudget,
    temperature: config.temperature,
    adaptiveRepetitionPenalty: config.adaptiveRepetitionPenalty,
    repetitionPenalty: config.repetitionPenalty,
    extraBody: config.extraBody
  });
}

function comparisonScore(run: BenchRun, ignoreIncompletePasses: boolean) {
  if (!ignoreIncompletePasses) return runMeanScore(run);
  if (run.comparison) return run.comparison.completePassMeanScore;
  return run.completed >= runTotal(run) ? runMeanScore(run) : null;
}

export function buildComparisonRows(
  runs: BenchRun[],
  benchmarkIds: string[],
  onlyBestModelResult: boolean,
  ignoreIncompletePasses: boolean,
  ignoreOutdatedResults = true
) {
  const rows = new Map<string, ComparisonRow>();
  for (const run of runs) {
    if (ignoreOutdatedResults && run.benchmarkDataOutdated) continue;
    const benchmarkId = runBenchmarkId(run);
    if (!benchmarkIds.includes(benchmarkId)) continue;
    const score = comparisonScore(run, ignoreIncompletePasses);
    if (score === null) continue;
    const key = onlyBestModelResult ? run.model : configurationKey(run);
    const row = rows.get(key) ?? {
      key,
      model: run.model || "Unknown model",
      providers: [],
      settings: onlyBestModelResult ? "Best across configurations" : runSettings(run),
      cells: new Map<string, ComparisonCell>(),
      averageScore: 0
    };
    const provider = providerLabel(run);
    if (!row.providers.includes(provider)) row.providers.push(provider);
    const previousCell = row.cells.get(benchmarkId);
    if (!previousCell || score > previousCell.score) row.cells.set(benchmarkId, { run, score });
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({
    ...row,
    providers: row.providers.sort(),
    averageScore: row.cells.size
      ? [...row.cells.values()].reduce((totalScore, cell) => totalScore + cell.score, 0) / row.cells.size
      : 0
  }));
}

type ComparisonRoute = Extract<BenchRoute, { view: "comparison" }>;

export function BenchmarkComparison({
  runs,
  route,
  onBack,
  onRouteChange
}: {
  runs: BenchRun[];
  route: ComparisonRoute;
  onBack: () => void;
  onRouteChange: (route: ComparisonRoute) => void;
}) {
  const [xMetricId, setXMetricId] = useState<ComparisonMetricId>("taskTime");
  const [yMetricId, setYMetricId] = useState<ComparisonMetricId>("score");
  const [sortKey, setSortKey] = useState("average");
  const [sortDescending, setSortDescending] = useState(true);
  const [tasksFullScreen, setTasksFullScreen] = useState(false);
  const benchmarkIds = useMemo(() => Array.from(new Set(runs.map(runBenchmarkId))).sort((left, right) => (
    benchmarkOption(left).label.localeCompare(benchmarkOption(right).label)
  )), [runs]);
  const models = useMemo(() => Array.from(new Set(runs.map((run) => run.model).filter(Boolean))).sort(), [runs]);
  const selectedBenchmarkIds = route.selectedBenchmarkIds ?? benchmarkIds;
  const selectedModels = route.selectedModels ?? models;
  const hiddenBenchmarkIds = new Set(benchmarkIds.filter((benchmarkId) => !selectedBenchmarkIds.includes(benchmarkId)));
  const hiddenModels = new Set(models.filter((model) => !selectedModels.includes(model)));
  const onlyBestModelResult = route.onlyBestModelResult !== false;
  const ignoreIncompletePasses = route.ignoreIncompletePasses !== false;
  const ignoreOutdatedResults = route.ignoreOutdatedResults !== false;
  const view = route.comparisonView ?? "chart";
  const visibleBenchmarkIds = benchmarkIds.filter((benchmarkId) => !hiddenBenchmarkIds.has(benchmarkId));
  const visibleRuns = runs.filter((run) => !hiddenModels.has(run.model));
  const rows = buildComparisonRows(
    visibleRuns,
    visibleBenchmarkIds,
    onlyBestModelResult,
    ignoreIncompletePasses,
    ignoreOutdatedResults
  )
    .sort((left, right) => {
      const direction = sortDescending ? -1 : 1;
      if (sortKey === "model") return direction * left.model.localeCompare(right.model);
      const leftScore = sortKey === "average" ? left.averageScore : left.cells.get(sortKey)?.score ?? -1;
      const rightScore = sortKey === "average" ? right.averageScore : right.cells.get(sortKey)?.score ?? -1;
      return direction * (leftScore - rightScore) || left.model.localeCompare(right.model);
    });

  function selectSort(nextSortKey: string) {
    if (sortKey === nextSortKey) setSortDescending((previous) => !previous);
    else {
      setSortKey(nextSortKey);
      setSortDescending(nextSortKey !== "model");
    }
  }

  return (
    <section className={`comparison-page${view === "tasks" && tasksFullScreen ? " task-fullscreen" : ""}`}>
      <header className="comparison-header">
        <button aria-label="Back to benchmarks" className="comparison-back" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <div>
          <p>Results matrix</p>
          <h1>Benchmark comparison</h1>
        </div>
      </header>
      <div className="comparison-controls">
        <MultiSelectFilter
          hiddenValues={hiddenBenchmarkIds}
          label="Benchmarks"
          options={benchmarkIds.map((benchmarkId) => ({ value: benchmarkId, label: benchmarkOption(benchmarkId).label }))}
          setHiddenValues={(hiddenValues) => onRouteChange({
            ...route,
            selectedBenchmarkIds: benchmarkIds.filter((benchmarkId) => !hiddenValues.has(benchmarkId))
          })}
        />
        <MultiSelectFilter
          hiddenValues={hiddenModels}
          label="Models"
          options={models.map((model) => ({ value: model, label: model }))}
          setHiddenValues={(hiddenValues) => onRouteChange({
            ...route,
            selectedModels: models.filter((model) => !hiddenValues.has(model))
          })}
        />
        <label className="comparison-check">
          <input
            checked={onlyBestModelResult}
            type="checkbox"
            onChange={(event) => onRouteChange({ ...route, onlyBestModelResult: event.target.checked })}
          />
          Only best model result
        </label>
        <label className="comparison-check">
          <input
            checked={ignoreIncompletePasses}
            type="checkbox"
            onChange={(event) => onRouteChange({ ...route, ignoreIncompletePasses: event.target.checked })}
          />
          Ignore incomplete passes
        </label>
        <label className="comparison-check">
          <input
            checked={ignoreOutdatedResults}
            type="checkbox"
            onChange={(event) => onRouteChange({ ...route, ignoreOutdatedResults: event.target.checked })}
          />
          Ignore outdated results
        </label>
        <div className="comparison-view-switch" role="group" aria-label="Comparison view">
          <button className={view === "chart" ? "active" : ""} type="button" onClick={() => onRouteChange({ ...route, comparisonView: "chart" })}>
            <BarChart3 size={15} />Chart
          </button>
          <button className={view === "table" ? "active" : ""} type="button" onClick={() => onRouteChange({ ...route, comparisonView: "table" })}>
            <Table2 size={15} />Table
          </button>
          <button className={view === "tasks" ? "active" : ""} type="button" onClick={() => onRouteChange({ ...route, comparisonView: "tasks" })}>
            <Columns3 size={15} />Tasks
          </button>
        </div>
      </div>
      {view === "chart" ? (
        <section className="comparison-chart-panel">
          <div className="comparison-axis-controls">
            <label>
              <span>X axis</span>
              <select value={xMetricId} onChange={(event) => setXMetricId(event.target.value as ComparisonMetricId)}>
                {COMPARISON_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
              </select>
            </label>
            <label>
              <span>Y axis</span>
              <select value={yMetricId} onChange={(event) => setYMetricId(event.target.value as ComparisonMetricId)}>
                {COMPARISON_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
              </select>
            </label>
          </div>
          <ComparisonScatterPlot
            ignoreIncompletePasses={ignoreIncompletePasses}
            onlyBestModelResult={onlyBestModelResult}
            rows={rows}
            xMetricId={xMetricId}
            yMetricId={yMetricId}
          />
        </section>
      ) : view === "tasks" ? <TaskComparison fullScreen={tasksFullScreen} rows={rows} setFullScreen={setTasksFullScreen} /> : <div className="comparison-table-wrap">
        <table className="comparison-table">
          <thead>
            <tr>
              <th className="comparison-model-column" scope="col">
                <button type="button" onClick={() => selectSort("model")}>Model {sortKey === "model" ? (sortDescending ? "↓" : "↑") : ""}</button>
              </th>
              <th scope="col">
                <button type="button" onClick={() => selectSort("average")}>Average {sortKey === "average" ? (sortDescending ? "↓" : "↑") : ""}</button>
              </th>
              {visibleBenchmarkIds.map((benchmarkId) => (
                <th key={benchmarkId} scope="col">
                  <button type="button" onClick={() => selectSort(benchmarkId)}>
                    {benchmarkOption(benchmarkId).label} {sortKey === benchmarkId ? (sortDescending ? "↓" : "↑") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th className="comparison-model-column" scope="row">
                  <strong>{row.model}</strong>
                  <span>{row.providers.join(", ")}</span>
                  <small>{row.settings}</small>
                </th>
                <td className="comparison-average">{pct(row.averageScore)}</td>
                {visibleBenchmarkIds.map((benchmarkId) => {
                  const cell = row.cells.get(benchmarkId);
                  const comparison = cell?.run.comparison;
                  const signalTotal = ignoreIncompletePasses
                    ? comparison?.completePassSignalTotal ?? 0
                    : comparison?.signalTotal ?? 0;
                  const loopingCount = ignoreIncompletePasses
                    ? comparison?.completePassLoopingCount ?? 0
                    : comparison?.loopingCount ?? 0;
                  const benchmarkMentionCount = ignoreIncompletePasses
                    ? comparison?.completePassBenchmarkMentionCount ?? 0
                    : comparison?.benchmarkMentionCount ?? 0;
                  return (
                    <td key={benchmarkId}>
                      {cell ? (
                        <div className="comparison-score">
                          <strong>{pct(cell.score)}</strong>
                          <span className="comparison-signals">
                            {loopingCount && signalTotal ? (
                              <span title={`${pct(loopingCount / signalTotal)} of attempts looped`}>
                                <Repeat2 aria-label="Looping detected" size={13} />
                                {pct(loopingCount / signalTotal)}
                              </span>
                            ) : null}
                            {benchmarkMentionCount && signalTotal ? (
                              <span title={`${pct(benchmarkMentionCount / signalTotal)} of attempts mentioned the benchmark`}>
                                <TriangleAlert aria-label="Benchmark mentions detected" size={13} />
                                {pct(benchmarkMentionCount / signalTotal)}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      ) : <span className="comparison-empty">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="comparison-empty-state">No complete results match these filters.</p> : null}
      </div>}
    </section>
  );
}