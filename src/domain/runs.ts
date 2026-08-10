import {
  DEFAULT_FORM_VALUES,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  type BenchResult,
  type BenchRun,
  type EventEnvelope
} from "./benchmark";

export function pct(value?: number | null) {
  return `${Math.round((value || 0) * 1000) / 10}%`;
}

export function normalizeParallelTasks(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(64, Math.max(1, Math.floor(value)));
}

export function normalizePassCount(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.passCount;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

export function normalizeCommentSignalThreshold(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_FORM_VALUES.commentSignalThreshold;
  return value;
}

export function runPassCount(run?: BenchRun | null) {
  return normalizePassCount(Number(run?.config?.passCount ?? 1));
}

export function runTotal(run?: BenchRun | null) {
  return run?.total || ((run?.selectedIndices?.length || 164) * runPassCount(run));
}

export function ordinal(value: number) {
  const normalized = Math.max(1, Math.floor(value));
  const mod100 = normalized % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${normalized}th`;
  switch (normalized % 10) {
    case 1:
      return `${normalized}st`;
    case 2:
      return `${normalized}nd`;
    case 3:
      return `${normalized}rd`;
    default:
      return `${normalized}th`;
  }
}

export function completedMetricLines(run?: BenchRun | null): Array<[string, string]> {
  const total = runTotal(run);
  const completed = Math.min(Math.max(run?.completed ?? 0, 0), total);
  const passCount = runPassCount(run);
  const passTotal = Math.max(1, Math.ceil(total / passCount));
  const currentPass = completed >= total
    ? passCount
    : Math.min(passCount, Math.floor(completed / passTotal) + 1);
  const currentPassCompleted = completed >= total ? passTotal : completed % passTotal;

  return [
    ["Total:", `${pct(total ? completed / total : 0)} (${completed}/${total})`],
    [`${ordinal(currentPass)} pass:`, `${pct(currentPassCompleted / passTotal)} (${currentPassCompleted}/${passTotal})`]
  ];
}

export function runMeanScore(run?: BenchRun | null) {
  if (!run) return 0;
  if (typeof run.meanScore === "number") return run.meanScore;
  return run.completed ? run.passed / run.completed : 0;
}

export function scoreRange(run?: BenchRun | null) {
  if (!run) return { worst: 0, best: 0 };
  const total = runTotal(run);
  const remaining = Math.max(total - run.completed, 0);
  // Score earned so far (graded tasks contribute fractions); the best case
  // assumes every remaining task scores 1, the worst assumes 0.
  const scoreSum = runMeanScore(run) * run.completed;
  return {
    worst: total ? scoreSum / total : 0,
    best: total ? (scoreSum + remaining) / total : 0
  };
}

export function progressSegments(run?: BenchRun | null) {
  if (!run) return { failed: 0, passed: 0, remaining: 100 };
  const total = runTotal(run);
  const remaining = Math.max(total - run.completed, 0);
  if (!total) return { failed: 0, passed: 0, remaining: 100 };
  // Earned vs lost credit. For binary runs the mean score IS the pass rate,
  // so this matches the old passed/failed widths exactly; for graded runs a
  // 0.7-scoring task fills 70% of its slice green instead of reading as a
  // full failure while the headline says "mean score 70%".
  const earned = runMeanScore(run) * run.completed;
  return {
    failed: ((run.completed - earned) / total) * 100,
    passed: (earned / total) * 100,
    remaining: (remaining / total) * 100
  };
}

export function formatMs(value?: number) {
  if (!value) return "n/a";
  if (value < 1000) return `${value}ms`;
  if (value >= 60_000) return formatDuration(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export function formatDuration(valueMs: number) {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTime(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

export function formatClock(valueMs: number) {
  const date = new Date(valueMs);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function currentTaskStartedAtMs(run: BenchRun | null, events: EventEnvelope[]) {
  if (!run?.currentTaskId) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "task-started") continue;
    if (event.data.taskId !== run.currentTaskId) continue;
    const timestamp = new Date(event.at).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const persistedTimestamp = new Date(run.activeTaskStartedAt?.[run.currentTaskId] ?? "").getTime();
  return Number.isFinite(persistedTimestamp) ? persistedTimestamp : null;
}

export function statusIsLive(status?: string) {
  return status === "running" || status === "queued";
}

// While any run is live the start/resume actions enqueue instead of starting,
// so the buttons must read "Add to queue" rather than "Start run".
export function anyRunLive(runs: BenchRun[] = []) {
  return runs.some((run) => statusIsLive(run.status));
}

export function runQueueBadgePosition(run: BenchRun) {
  return run.status === "queued" && typeof run.queuePosition === "number" && run.queuePosition > 0
    ? run.queuePosition
    : null;
}

// Runtime/network failures (e.g. "no model loaded") are recorded as
// completed results so the run finishes normally, but the server discards
// them on resume. A run stuck at "completed" purely because every remaining
// task hit one of these errors still needs the Resume button enabled.
export function runHasModelErrorResults(run?: BenchRun | null) {
  return (run?.results || []).some((result) => Boolean(result.modelError));
}

export function runCanResume(run?: BenchRun | null) {
  if (!run) return false;
  if (statusIsLive(run.status)) return false;
  const hasModelErrors = runHasModelErrorResults(run);
  if (run.status === "completed" && !hasModelErrors) return false;
  return run.completed < runTotal(run) || hasModelErrors;
}

export function statusIsInProgress(status?: string) {
  return status === "running";
}

export function resultActiveDurationMilliseconds(result: BenchResult) {
  return validDurationMilliseconds(result.activeDurationMilliseconds)
    || validDurationMilliseconds(result.generationMs);
}

export function activeTaskElapsedDurationsMilliseconds(
  run: BenchRun | null,
  events: EventEnvelope[],
  nowMilliseconds: number,
  currentTaskStartedAtMilliseconds?: number | null
) {
  if (!run || !statusIsInProgress(run.status)) return [];
  const activeTaskIds = new Set(run.activeTaskIds ?? []);
  if (run.currentTaskId) activeTaskIds.add(run.currentTaskId);
  return [...activeTaskIds].map((taskId) => {
    const startedAtMilliseconds = taskId === run.currentTaskId && currentTaskStartedAtMilliseconds
      ? currentTaskStartedAtMilliseconds
      : taskStartedAtMilliseconds(taskId, events);
    return startedAtMilliseconds ? Math.max(nowMilliseconds - startedAtMilliseconds, 0) : 0;
  }).filter((durationMilliseconds) => durationMilliseconds > 0);
}

export function liveEstimate(
  run: BenchRun | null,
  events: EventEnvelope[],
  nowMilliseconds: number,
  currentTaskStartedAtMilliseconds?: number | null
) {
  if (!run || !statusIsLive(run.status)) return null;
  const total = runTotal(run);
  const remainingTasks = Math.max(total - run.completed, 0);
  if (run.completed <= 0 || remainingTasks <= 0) return null;
  const parallelTasks = Math.max(1, Math.floor(Number(run.config?.parallelTasks ?? 1)));
  const completedTaskMilliseconds = completedActiveDurationMilliseconds(run);
  const averageTaskMilliseconds = averageTaskDurationMilliseconds(run);
  if (!averageTaskMilliseconds) return null;
  const activeTaskDurationsMilliseconds = activeTaskElapsedDurationsMilliseconds(
    run,
    events,
    nowMilliseconds,
    currentTaskStartedAtMilliseconds
  );
  const activeTaskCount = Math.min(activeTaskDurationsMilliseconds.length, remainingTasks);
  const queuedTaskCount = remainingTasks - activeTaskCount;
  const activeTasksRemainingMilliseconds = activeTaskDurationsMilliseconds.reduce(
    (totalMilliseconds, durationMilliseconds) => (
      totalMilliseconds + Math.max(averageTaskMilliseconds - durationMilliseconds, 0)
    ),
    0
  );
  const remainingActiveMilliseconds = activeTasksRemainingMilliseconds + (averageTaskMilliseconds * queuedTaskCount);
  const remainingMilliseconds = estimatedParallelRemainingMilliseconds(
    activeTaskDurationsMilliseconds,
    queuedTaskCount,
    averageTaskMilliseconds,
    parallelTasks
  );
  const currentActiveMilliseconds = activeTaskDurationsMilliseconds.reduce(
    (totalMilliseconds, durationMilliseconds) => totalMilliseconds + durationMilliseconds,
    0
  );
  return {
    remaining: formatDuration(remainingMilliseconds),
    endTime: formatClock(nowMilliseconds + remainingMilliseconds),
    expectedTotal: formatDuration(completedTaskMilliseconds + currentActiveMilliseconds + remainingActiveMilliseconds)
  };
}

export function speedStats(
  run: BenchRun | null,
  events: EventEnvelope[],
  nowMilliseconds: number,
  currentTaskStartedAtMilliseconds?: number | null
) {
  if (!run) return { averageTask: "n/a", elapsed: "n/a" };
  const completedTaskMilliseconds = completedActiveDurationMilliseconds(run);
  const activeTaskMilliseconds = activeTaskElapsedDurationsMilliseconds(
    run,
    events,
    nowMilliseconds,
    currentTaskStartedAtMilliseconds
  ).reduce((totalMilliseconds, durationMilliseconds) => totalMilliseconds + durationMilliseconds, 0);
  const elapsedMilliseconds = completedTaskMilliseconds + activeTaskMilliseconds;
  const averageTaskMilliseconds = averageTaskDurationMilliseconds(run);
  return {
    averageTask: averageTaskMilliseconds ? formatMs(averageTaskMilliseconds) : "n/a",
    elapsed: elapsedMilliseconds > 0 ? formatDuration(elapsedMilliseconds) : "n/a"
  };
}

function completedActiveDurationMilliseconds(run: BenchRun) {
  return run.results.reduce(
    (totalMilliseconds, result) => totalMilliseconds + resultActiveDurationMilliseconds(result),
    0
  );
}

function averageTaskDurationMilliseconds(run: BenchRun) {
  const resultDurations = run.results
    .map(resultActiveDurationMilliseconds)
    .filter((durationMilliseconds) => durationMilliseconds > 0);
  if (resultDurations.length) {
    return resultDurations.reduce((totalDuration, duration) => totalDuration + duration, 0) / resultDurations.length;
  }
  return null;
}

function taskStartedAtMilliseconds(taskId: string, events: EventEnvelope[]) {
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex];
    if (event.type !== "task-started" || event.data.taskId !== taskId) continue;
    const timestamp = new Date(event.at).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

export function estimatedParallelRemainingMilliseconds(
  activeTaskDurationsMilliseconds: number[],
  queuedTaskCount: number,
  averageTaskMilliseconds: number,
  parallelTasks: number
) {
  const remainingTaskCount = activeTaskDurationsMilliseconds.length + queuedTaskCount;
  if (!remainingTaskCount) return 0;
  const workerCount = Math.min(Math.max(1, parallelTasks), remainingTaskCount);
  const workerLoadsMilliseconds = activeTaskDurationsMilliseconds
    .slice(0, workerCount)
    .map((durationMilliseconds) => Math.max(averageTaskMilliseconds - durationMilliseconds, 0));
  while (workerLoadsMilliseconds.length < workerCount) workerLoadsMilliseconds.push(0);
  for (let taskIndex = 0; taskIndex < queuedTaskCount; taskIndex += 1) {
    const nextWorkerIndex = workerLoadsMilliseconds.indexOf(Math.min(...workerLoadsMilliseconds));
    workerLoadsMilliseconds[nextWorkerIndex] += averageTaskMilliseconds;
  }
  return Math.max(...workerLoadsMilliseconds);
}

function validDurationMilliseconds(value?: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function assertionStats(results: BenchResult[] = []) {
  const total = results.reduce((sum, result) => sum + result.tests.length, 0);
  const passed = results.reduce((sum, result) => sum + result.tests.filter((test) => test.passed).length, 0);
  return { passed, total, score: total ? passed / total : 0 };
}

export function formatAssert(test: BenchResult["tests"][number]) {
  const scoreSuffix = typeof test.score === "number" ? ` (score ${pct(test.score)})` : "";
  const confidenceSuffix =
    typeof test.confidence === "number" ? ` (confidence ${pct(test.confidence)})` : "";
  const lines = [`${test.passed ? "PASS" : "FAIL"} ${test.source}${scoreSuffix}${confidenceSuffix}`];
  if (!test.passed && (test.expected !== undefined || test.actual !== undefined)) {
    lines.push(`expected: ${test.expected ?? "n/a"}`);
    lines.push(`actual:   ${test.actual ?? "n/a"}`);
    if (test.operator) lines.push(`operator: ${test.operator}`);
  }
  if (!test.passed && test.error) lines.push(`error: ${test.error}`);
  return lines.join("\n");
}

export type CompletedResultStatus = "pass" | "partial" | "fail" | "error" | "loop";

export function resultScore(result: BenchResult): number {
  const numeric = Number(result.score);
  if (Number.isFinite(numeric)) return Math.min(1, Math.max(0, numeric));
  return result.passed ? 1 : 0;
}

export function resultStatus(result: BenchResult): CompletedResultStatus {
  if (result.passed) return "pass";
  if (result.looping) return "loop";
  if (result.tests.length === 0) return "error";
  // Status keys on ANSWER quality, not the confidence-weighted composite: a
  // wrong answer with honest low confidence earns score crumbs but must stay
  // red, not amber. Legacy results without answerScore fall back to score.
  const quality = Number(result.answerScore ?? result.score);
  if (Number.isFinite(quality) && quality > 0 && quality < 1) return "partial";
  return "fail";
}

export function failureStats(results: BenchResult[] = []) {
  return results.reduce(
    (stats, result) => {
      const status = resultStatus(result);
      if (status === "fail") stats.failedAssertions += 1;
      if (status === "partial") stats.partial += 1;
      if (status === "error") stats.errors += 1;
      if (status === "loop") stats.looping += 1;
      return stats;
    },
    { failedAssertions: 0, partial: 0, errors: 0, looping: 0 }
  );
}

export function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra request body must be a JSON object.");
  }
  return parsed;
}

export function resultNumbers(run: BenchRun | null, status: CompletedResultStatus) {
  return (run?.results ?? [])
    .filter((result) => resultStatus(result) === status)
    .map((result) => result.index)
    .filter((index, position, indices) => indices.indexOf(index) === position)
    .sort((a, b) => a - b)
    .join(", ");
}

export function mergeRun(previous: BenchRun | undefined, next: BenchRun) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    results: next.results.length ? next.results : previous.results
  };
}

export function mergeRunList(previous: BenchRun[], nextRuns: BenchRun[]) {
  return nextRuns.map((next) => mergeRun(previous.find((run) => run.id === next.id), next));
}

export function updateRunInPlace(previous: BenchRun[], next: BenchRun) {
  const index = previous.findIndex((run) => run.id === next.id);
  if (index === -1) return [next, ...previous];
  return previous.map((run, runIndex) => (runIndex === index ? mergeRun(run, next) : run));
}

export function formatExtraBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  return JSON.stringify(value, null, 2);
}

export function readSidebarCollapsed(win: Window = window) {
  return win.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}
