import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { BENCH_API, runBenchmarkKind, runBenchmarkScoring, type BenchResult, type BenchRun, type BenchTaskImage, type TaskGroup, type TaskPromptInfo, type TokenEvent } from "../domain/benchmark";
import {
  analyzeThinkingComments,
  commentSignalIsFlagged,
  formatCommentSignal
} from "../domain/comments";
import {
  groupedTaskDurationLabel,
  groupSequentialPasses,
  passRangeLabel
} from "../domain/passes";
import { buildInstructionPromptFallback } from "../domain/prompts";
import { recordTaskResultsRenderMeasurement, textByteLength } from "../domain/performanceMetrics";
import { formatAssert, formatDuration, pct, resultHasDetectedLoop, resultScore, runPassCount } from "../domain/runs";
import { orderedChannelOutput } from "../domain/tasks";

function primaryResultStatus(
  status: TaskGroup["attempts"][number]["status"],
  result?: BenchResult
) {
  if (status !== "loop") return status;
  return result?.tests.length ? "fail" : "error";
}

/**
 * The photographs that were attached to the model call, loaded from the bench
 * server (only file names are persisted in results and events). Rendered at
 * the top of the "Prompt sent to model" panel so what the model saw is
 * visible next to what it read.
 */
function PromptImages({ images }: { images?: BenchTaskImage[] }) {
  if (!images?.length) return null;
  return (
    <div className="prompt-images">
      {images.map((image, imageIndex) => (
        <figure key={image.file}>
          <a href={`${BENCH_API}${image.url}`} rel="noreferrer" target="_blank">
            <img
              alt={`Photograph ${imageIndex + 1} sent to the model`}
              loading="lazy"
              src={`${BENCH_API}${image.url}`}
            />
          </a>
          <figcaption>
            Photograph {imageIndex + 1}
            {image.postedAt ? ` · posted ${image.postedAt}` : " · posted date unknown"}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function LoopHighlightedText({
  text,
  loopDetection,
  channel
}: {
  text: string;
  loopDetection?: BenchResult["loopDetection"];
  channel: string;
}) {
  if (loopDetection?.channel !== channel || !loopDetection.occurrences?.length) {
    return <pre>{text}</pre>;
  }
  const occurrences = loopDetection.occurrences
    .filter(({ start, end }) => (
      Number.isInteger(start)
      && Number.isInteger(end)
      && start >= 0
      && end > start
      && end <= text.length
    ))
    .sort((left, right) => left.start - right.start);
  if (!occurrences.length) return <pre>{text}</pre>;

  const content: React.ReactNode[] = [];
  let cursor = 0;
  occurrences.forEach((occurrence, index) => {
    if (occurrence.start < cursor) return;
    if (occurrence.start > cursor) content.push(text.slice(cursor, occurrence.start));
    const repetitionNumber = index + 1;
    content.push(
      <mark className="loop-highlight" key={`${occurrence.start}-${occurrence.end}`}>
        <span className="loop-boundary">Loop {repetitionNumber} start</span>
        {text.slice(occurrence.start, occurrence.end)}
        <span className="loop-boundary loop-boundary-end">Loop {repetitionNumber} end</span>
      </mark>
    );
    cursor = occurrence.end;
  });
  if (cursor < text.length) content.push(text.slice(cursor));
  return <pre>{content}</pre>;
}

export function TaskResults({
  taskGroups,
  selectedRun,
  tokensByAttempt,
  promptInfoByAttempt,
  expanded,
  selectedPassByTask,
  commentSignalThreshold,
  currentTimeMilliseconds,
  setExpanded,
  setSelectedPassByTask
}: {
  taskGroups: TaskGroup[];
  selectedRun: BenchRun | null;
  tokensByAttempt: Map<string, TokenEvent[]>;
  promptInfoByAttempt: Map<string, TaskPromptInfo>;
  expanded: Record<string, boolean>;
  selectedPassByTask: Record<string, number>;
  commentSignalThreshold: number;
  currentTimeMilliseconds: number;
  setExpanded: (updater: (previous: Record<string, boolean>) => Record<string, boolean>) => void;
  setSelectedPassByTask: (updater: (previous: Record<string, number>) => Record<string, number>) => void;
}) {
  const performanceMetricsEnabled = typeof window !== "undefined" && Boolean(window.llmEvalPerformanceMetrics);
  const benchmarkKind = runBenchmarkKind(selectedRun);
  const isCodeBenchmark = benchmarkKind === "code";
  const isGradedBenchmark = runBenchmarkScoring(selectedRun) === "graded";
  const adaptiveRepetitionPenalty = Boolean(selectedRun?.config?.adaptiveRepetitionPenalty);
  const labels = isCodeBenchmark
    ? {
        ledger: "Assert ledger",
        ledgerEmpty: "No assertions ran.",
        extracted: "Extracted code",
        task: "Original HumanEval task",
        reference: "HumanEval tests",
        checks: "asserts"
      }
    : {
        ledger: "Answer check",
        ledgerEmpty: "No answer was checked.",
        extracted: "Extracted answer",
        task: "Task input",
        reference: "Expected answer",
        checks: "checks"
      };
  let detailPanelCount = 0;
  let visiblePreTextBytes = 0;
  let attemptViewBuildDurationMilliseconds = 0;
  return (
    <section className="results-panel">
      <div className="pane-head">Tasks</div>
      {taskGroups.length ? taskGroups.map((group) => {
        const runningAttempt = group.attempts.find((attempt) => attempt.status === "running");
        const passTotal = Math.max(runPassCount(selectedRun), ...group.attempts.map((attempt) => attempt.passTotal || 1));
        const attemptViewBuildStartedAt = performanceMetricsEnabled ? performance.now() : 0;
        const attemptViews = group.attempts.map((attempt) => {
          const attemptResult = attempt.result;
          const promptInfo = promptInfoByAttempt.get(attempt.key);
          const originalPrompt = attemptResult?.prompt || promptInfo?.prompt || attempt.prompt;
          const instructionPrompt = attemptResult?.instructionPrompt
            || promptInfo?.instructionPrompt
            || buildInstructionPromptFallback(selectedRun, originalPrompt);
          const testPrompt = attemptResult?.test || promptInfo?.test || attempt.test;
          const liveOutput = orderedChannelOutput(tokensByAttempt.get(attempt.key));
          const commentSignal = isCodeBenchmark ? analyzeThinkingComments(attemptResult) : undefined;
          return {
            attempt,
            originalPrompt,
            instructionPrompt,
            testPrompt,
            liveOutput,
            commentSignal,
            thinkingInComments: isCodeBenchmark && commentSignalIsFlagged(commentSignal, commentSignalThreshold),
            mergeKey: JSON.stringify({
              status: attempt.status,
              entryPoint: attempt.entryPoint,
              originalPrompt,
              instructionPrompt,
              testPrompt,
              liveOutput: attempt.status === "running" ? liveOutput : null,
              commentSignal: attemptResult ? formatCommentSignal(commentSignal, commentSignalThreshold) : null,
              modelError: attemptResult?.modelError ?? null,
              tests: attemptResult?.tests ?? null,
              thinkingOutput: attemptResult?.thinkingOutput ?? null,
              rawOutput: attemptResult?.rawOutput ?? null,
              extractedCode: attemptResult?.extractedCode ?? null,
              traceback: attemptResult?.traceback ?? null,
              error: attemptResult?.error ?? null,
              harnessStderr: attemptResult?.harnessStderr ?? null
            })
          };
        });
        if (performanceMetricsEnabled) attemptViewBuildDurationMilliseconds += performance.now() - attemptViewBuildStartedAt;
        const passTabGroups = groupSequentialPasses(attemptViews);
        const requestedPass = selectedPassByTask[group.taskId];
        const activePassGroup = passTabGroups.find((tabGroup) => (
          requestedPass !== undefined
          && requestedPass >= tabGroup.startPass
          && requestedPass <= tabGroup.endPass
        ))
          ?? passTabGroups.find((tabGroup) => tabGroup.status === "running")
          ?? passTabGroups[0];
        const row = activePassGroup?.representative ?? runningAttempt ?? group.attempts[0];
        const activeAttemptView = attemptViews.find((view) => view.attempt.key === row.key);
        const result = row.result;
        const liveOutput = activeAttemptView?.liveOutput ?? orderedChannelOutput(tokensByAttempt.get(row.key));
        const isRunning = row.status === "running";
        const groupIsRunning = group.attempts.some((attempt) => attempt.status === "running");
        const groupStatus = groupIsRunning
          ? "running"
          : group.attempts.every((attempt) => attempt.status === "pass")
            ? "pass"
            : group.attempts.some((attempt) => attempt.status === "fail")
              ? "fail"
              : group.attempts.some((attempt) => attempt.status === "partial")
                ? "partial"
                : group.attempts.some((attempt) => attempt.status === "loop")
                  ? "loop"
                  : "error";
        const isOpen = expanded[group.taskId] ?? groupIsRunning;
        const completedPasses = group.attempts.filter((attempt) => attempt.status !== "running").length;
        const passedPasses = group.attempts.filter((attempt) => attempt.status === "pass").length;
        const assertsPassed = result?.tests.filter((test) => test.passed).length ?? 0;
        const assertScore = result?.tests.length ? assertsPassed / result.tests.length : 0;
        const commentSignal = activeAttemptView?.commentSignal ?? (isCodeBenchmark ? analyzeThinkingComments(result) : undefined);
        const thinkingInComments = activeAttemptView?.thinkingInComments
          ?? (isCodeBenchmark && commentSignalIsFlagged(commentSignal, commentSignalThreshold));
        const originalPrompt = activeAttemptView?.originalPrompt ?? result?.prompt ?? row.prompt;
        const instructionPrompt = activeAttemptView?.instructionPrompt
          ?? result?.instructionPrompt
          ?? buildInstructionPromptFallback(selectedRun, originalPrompt);
        const testPrompt = activeAttemptView?.testPrompt ?? result?.test ?? row.test;
        const runningStartedAtMilliseconds = row.startedAt ? new Date(row.startedAt).getTime() : Number.NaN;
        const runningDuration = isRunning && Number.isFinite(runningStartedAtMilliseconds)
          ? formatDuration(Math.max(currentTimeMilliseconds - runningStartedAtMilliseconds, 0))
          : null;
        const displayedRepetitionPenalty = adaptiveRepetitionPenalty
          && typeof (isRunning ? row.repetitionPenalty : result?.repetitionPenalty) === "number"
          ? (isRunning ? row.repetitionPenalty : result?.repetitionPenalty)
          : null;
        if (performanceMetricsEnabled && isOpen) {
          detailPanelCount += 1;
          visiblePreTextBytes += textByteLength(instructionPrompt || "Prompt pending.");
          visiblePreTextBytes += textByteLength(originalPrompt || "Task prompt pending.");
          visiblePreTextBytes += textByteLength(testPrompt || "Tests pending.");
          visiblePreTextBytes += liveOutput.reduce((totalBytes, [channel, text]) => totalBytes + textByteLength(`${channel}\n\n${text}`), 0);
          if (result?.modelError) visiblePreTextBytes += textByteLength(result.modelError);
          if (result?.tests.length) {
            visiblePreTextBytes += result.tests.reduce((totalBytes, test) => totalBytes + textByteLength(formatAssert(test)), 0);
          }
          if (thinkingInComments) visiblePreTextBytes += textByteLength(formatCommentSignal(commentSignal, commentSignalThreshold));
          if (result?.thinkingOutput) visiblePreTextBytes += textByteLength(result.thinkingOutput);
          if (result?.rawOutput) visiblePreTextBytes += textByteLength(result.rawOutput);
          if (result?.extractedCode) visiblePreTextBytes += textByteLength(result.extractedCode);
          if (result?.traceback || result?.error || result?.harnessStderr) {
            visiblePreTextBytes += textByteLength(result.traceback || result.error || result.harnessStderr || "No harness error.");
          }
        }
        if (performanceMetricsEnabled && group === taskGroups[taskGroups.length - 1]) {
          recordTaskResultsRenderMeasurement({
            runId: selectedRun?.id ?? null,
            taskRowCount: taskGroups.length,
            detailPanelCount,
            visiblePreTextBytes,
            attemptViewBuildDurationMilliseconds
          });
        }
        return (
          <article className={`result-row ${groupIsRunning ? "in-progress" : ""}`} key={group.taskId}>
            <button type="button" onClick={() => setExpanded((prev) => ({ ...prev, [group.taskId]: !isOpen }))}>
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="status-badges">
                <span className={`${primaryResultStatus(groupStatus, result)}-pill`}>
                  {primaryResultStatus(groupStatus, result)}
                </span>
                {group.attempts.some((attempt) => attempt.result && resultHasDetectedLoop(attempt.result)) ? <span className="loop-pill">loop</span> : null}
              </span>
              <strong>{group.taskId}</strong>
              <small>
                #{group.index} · {(isCodeBenchmark
                  ? (row.entryPoint || group.entryPoint)
                  : (row.subtask || result?.subtask)) || (isCodeBenchmark ? "entry point pending" : "subtask pending")} · {passedPasses}/{completedPasses || 0} passes passing
                {passTotal > 1 ? ` · ${completedPasses}/${passTotal} passes complete` : ""}
                {result && isGradedBenchmark ? ` · score ${pct(resultScore(result))}` : ""}
                {result ? ` · ${passRangeLabel(activePassGroup.startPass, activePassGroup.endPass, passTotal)} · ${assertsPassed}/${result.tests.length} ${labels.checks} · ${pct(assertScore)}` : ""}
                {isRunning ? ` · ${runningDuration ?? "in progress"}` : result ? ` · ${groupedTaskDurationLabel(activePassGroup.attempts)}` : ""}
                {displayedRepetitionPenalty !== null ? ` · penalty ${displayedRepetitionPenalty}` : ""}
                {isRunning && runningDuration ? " · in progress" : ""}
                {thinkingInComments ? <span className="comment-flag"><AlertTriangle size={12} /> thinking in comments</span> : null}
              </small>
            </button>
            {isOpen ? (
              <div className="result-detail">
                {passTotal > 1 || group.attempts.length > 1 ? (
                  <div className="pass-tabs" role="tablist" aria-label={`${group.taskId} passes`}>
                    {passTabGroups.map((tabGroup) => {
                      const attempt = tabGroup.representative;
                      const attemptAssertsPassed = attempt.result?.tests.filter((test) => test.passed).length ?? 0;
                      return (
                        <button
                          aria-selected={tabGroup.key === activePassGroup.key}
                          className={tabGroup.key === activePassGroup.key ? "active" : ""}
                          key={tabGroup.key}
                          role="tab"
                          type="button"
                          onClick={() => setSelectedPassByTask((prev) => ({ ...prev, [group.taskId]: tabGroup.startPass }))}
                        >
                          <span className="status-badges">
                            <span className={`${primaryResultStatus(tabGroup.status, attempt.result)}-pill`}>
                              {primaryResultStatus(tabGroup.status, attempt.result)}
                            </span>
                            {tabGroup.attempts.some((tabAttempt) => tabAttempt.result && resultHasDetectedLoop(tabAttempt.result)) ? <span className="loop-pill">loop</span> : null}
                          </span>
                          <strong>{passRangeLabel(tabGroup.startPass, tabGroup.endPass, passTotal)}</strong>
                          <small>
                            {attempt.result
                              ? `${attemptAssertsPassed}/${attempt.result.tests.length} ${labels.checks} · ${groupedTaskDurationLabel(tabGroup.attempts)}`
                              : "in progress"}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {isRunning ? (
                  <details open>
                    <summary>Live output</summary>
                    {liveOutput.length ? liveOutput.map(([channel, text]) => (
                      <pre key={channel}>{`${channel}\n\n${text}`}</pre>
                    )) : <pre>Waiting for model tokens...</pre>}
                  </details>
                ) : null}
                {result?.modelError ? <pre>{result.modelError}</pre> : null}
                {result?.loopDetection ? <pre className="loop-signal">Detected {result.loopDetection.repetitions} repeated cycles in {result.loopDetection.channel} ({result.loopDetection.patternWords} words per cycle). {result.looping ? "Generation stopped early." : "Generation continued to its normal finish."}</pre> : null}
                {thinkingInComments ? <details open><summary>Thinking in comments</summary><pre className="comment-signal">{formatCommentSignal(commentSignal, commentSignalThreshold)}</pre></details> : null}
                {result ? <details open><summary>{labels.ledger}</summary>{result.tests.length ? result.tests.map((test, index) => <pre key={index} className={test.passed ? "assert-pass" : "assert-fail"}>{formatAssert(test)}</pre>) : <pre className={row.status === "error" ? "assert-error" : undefined}>{labels.ledgerEmpty}</pre>}</details> : null}
                <details open><summary>Prompt sent to model</summary><PromptImages images={result?.images ?? row.images} /><pre>{instructionPrompt || "Prompt pending."}</pre></details>
                <details><summary>{labels.task}</summary><pre>{originalPrompt || "Task prompt pending."}</pre></details>
                {result ? <details><summary>Thinking</summary><LoopHighlightedText channel="thinking" loopDetection={result.loopDetection} text={result.thinkingOutput || "No separate thinking stream captured."} /></details> : null}
                {result ? <details><summary>Raw output</summary><LoopHighlightedText channel="output" loopDetection={result.loopDetection} text={result.rawOutput} /></details> : null}
                {result ? <details><summary>{labels.extracted}</summary><pre>{result.extractedCode}</pre></details> : null}
                <details><summary>{labels.reference}</summary><pre>{testPrompt || (isCodeBenchmark ? "Tests pending." : "Expected answer pending.")}</pre></details>
                {result ? <details open={row.status === "error"}><summary>Traceback / harness</summary><pre className={row.status === "error" ? "harness-error" : undefined}>{result.traceback || result.error || result.modelError || result.harnessStderr || (row.status === "error" ? "Harness failed without recording diagnostic details (legacy result)." : "No harness error.")}</pre></details> : null}
              </div>
            ) : null}
          </article>
        );
      }) : <p className="empty-copy">Tasks will appear as soon as they start.</p>}
    </section>
  );
}
