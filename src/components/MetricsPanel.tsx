import { Bell, BellOff, ClipboardCopy } from "lucide-react";
import { runBenchmarkKind, runBenchmarkScoring, type BenchRun } from "../domain/benchmark";
import { benchmarkMentionRegexIsValid } from "../domain/benchmarkMentions";
import type { CurrentPassTiming } from "../domain/passTiming";
import {
  assertionStats,
  completedMetricLines,
  failureStats,
  normalizeCommentSignalThreshold,
  pct,
  runMeanScore,
  statusIsInProgress
} from "../domain/runs";
import { Metric, MetricLines, type MetricLine } from "./Metric";

export function MetricsPanel({
  selectedRun,
  selectedThinkingStats,
  selectedBenchmarkMentionStats,
  commentSignalThreshold,
  benchmarkMentionRegex,
  selectedLiveEstimate,
  selectedPassTiming,
  selectedSpeedStats,
  selectedRunNotificationsEnabled,
  setCommentSignalThreshold,
  setBenchmarkMentionRegex,
  onCopyNumbers,
  onCopyThinkingNumbers,
  onCopyBenchmarkMentionNumbers,
  onToggleNotifications
}: {
  selectedRun: BenchRun | null;
  selectedThinkingStats: { flagged: number; total: number };
  selectedBenchmarkMentionStats: { flagged: number; total: number };
  commentSignalThreshold: number;
  benchmarkMentionRegex: string;
  selectedLiveEstimate: { remaining: string; endTime: string; expectedTotal: string } | null;
  selectedPassTiming: CurrentPassTiming | null;
  selectedSpeedStats: { averageTask: string; elapsed: string };
  selectedRunNotificationsEnabled: boolean;
  setCommentSignalThreshold: (value: number) => void;
  setBenchmarkMentionRegex: (value: string) => void;
  onCopyNumbers: (status: "pass" | "partial" | "fail" | "error" | "loop") => void;
  onCopyThinkingNumbers: (flagged: boolean) => void;
  onCopyBenchmarkMentionNumbers: (flagged: boolean) => void;
  onToggleNotifications: (run: BenchRun) => void;
}) {
  const failures = failureStats(selectedRun?.results);
  const hasValidBenchmarkMentionRegex = benchmarkMentionRegexIsValid(benchmarkMentionRegex);
  const isCodeBenchmark = runBenchmarkKind(selectedRun) === "code";
  const isGradedBenchmark = runBenchmarkScoring(selectedRun) === "graded";
  const checksLabel = isCodeBenchmark ? "Assertions" : "Answer checks";
  const failedLines: Array<[string, string]> = [
    [checksLabel, String(failures.failedAssertions)],
    ...(isGradedBenchmark ? ([["Partial", String(failures.partial)]] as Array<[string, string]>) : []),
    ["Errors", String(failures.errors)],
    ["Looping", String(failures.looping)]
  ];
  return (
    <section className="bench-metrics">
      <Metric label="Completed" value={<MetricLines lines={completedMetricLines(selectedRun)} />} />
      {isGradedBenchmark ? (
        <Metric label="Mean score" value={selectedRun ? pct(runMeanScore(selectedRun)) : "0%"} tone="passed" />
      ) : null}
      <Metric label="Passed" value={String(selectedRun?.passed ?? 0)} tone="passed">
        <button className="metric-action" type="button" onClick={() => onCopyNumbers("pass")} disabled={!selectedRun?.results.length}>
          <ClipboardCopy size={14} /> Copy passed
        </button>
      </Metric>
      <Metric
        label="Failed"
        value={<MetricLines lines={failedLines} />}
        tone="failed"
      >
        <div className="metric-actions">
          <button className="metric-action" type="button" onClick={() => onCopyNumbers("fail")} disabled={!failures.failedAssertions}>
            <ClipboardCopy size={14} /> {isCodeBenchmark ? "Copy assertion failures" : "Copy wrong answers"}
          </button>
          {isGradedBenchmark ? (
            <button className="metric-action" type="button" onClick={() => onCopyNumbers("partial")} disabled={!failures.partial}>
              <ClipboardCopy size={14} /> Copy partial
            </button>
          ) : null}
          <button className="metric-action" type="button" onClick={() => onCopyNumbers("error")} disabled={!failures.errors}>
            <ClipboardCopy size={14} /> Copy runtime errors
          </button>
          <button className="metric-action" type="button" onClick={() => onCopyNumbers("loop")} disabled={!failures.looping}>
            <ClipboardCopy size={14} /> Copy looping
          </button>
        </div>
      </Metric>
      <Metric
        label={checksLabel}
        value={
          selectedRun
            ? `${selectedRun.assertionsPassed ?? assertionStats(selectedRun.results).passed}/${selectedRun.assertionsTotal ?? assertionStats(selectedRun.results).total} (${pct(selectedRun.assertionScore ?? assertionStats(selectedRun.results).score)})`
            : "0/0 (0%)"
        }
      />
      {isCodeBenchmark ? (
        <Metric
          label="Thinking in comments"
          value={selectedRun ? `${selectedThinkingStats.flagged}/${selectedThinkingStats.total}` : "0/0"}
        >
          <div className="metric-actions">
            <button className="metric-action" type="button" onClick={() => onCopyThinkingNumbers(true)} disabled={!selectedRun?.results.length}>
              <ClipboardCopy size={14} /> Copy detected
            </button>
            <button className="metric-action" type="button" onClick={() => onCopyThinkingNumbers(false)} disabled={!selectedRun?.results.length}>
              <ClipboardCopy size={14} /> Copy clean
            </button>
          </div>
          <label className="metric-input">
            <span>Threshold</span>
            <input
              value={commentSignalThreshold}
              type="number"
              onChange={(event) => setCommentSignalThreshold(normalizeCommentSignalThreshold(Number(event.target.value)))}
            />
            <b>%</b>
          </label>
        </Metric>
      ) : null}
      <Metric
        label="Mentioned benchmark name"
        value={hasValidBenchmarkMentionRegex
          ? (selectedRun ? `${selectedBenchmarkMentionStats.flagged}/${selectedBenchmarkMentionStats.total}` : "0/0")
          : "Invalid"}
      >
        <div className="metric-actions">
          <button className="metric-action" type="button" onClick={() => onCopyBenchmarkMentionNumbers(true)} disabled={!selectedRun?.results.length || !hasValidBenchmarkMentionRegex}>
            <ClipboardCopy size={14} /> Copy detected
          </button>
          <button className="metric-action" type="button" onClick={() => onCopyBenchmarkMentionNumbers(false)} disabled={!selectedRun?.results.length || !hasValidBenchmarkMentionRegex}>
            <ClipboardCopy size={14} /> Copy clean
          </button>
        </div>
        <label className="metric-input metric-input-wide">
          <span>Regex</span>
          <input
            value={benchmarkMentionRegex}
            type="text"
            aria-describedby={hasValidBenchmarkMentionRegex ? undefined : "benchmark-mention-regex-error"}
            aria-invalid={!hasValidBenchmarkMentionRegex}
            onChange={(event) => setBenchmarkMentionRegex(event.target.value)}
          />
          {!hasValidBenchmarkMentionRegex ? (
            <small className="metric-input-error" id="benchmark-mention-regex-error">Invalid regular expression</small>
          ) : null}
        </label>
      </Metric>
      {statusIsInProgress(selectedRun?.status) ? (
        <Metric
          label="Remaining"
          value={remainingMetricLines(selectedLiveEstimate, selectedPassTiming).length
            ? (
                <MetricLines
                  lines={remainingMetricLines(selectedLiveEstimate, selectedPassTiming)}
                />
              )
            : "Estimating..."}
        >
          {selectedRun ? (
            <button
              className="metric-action"
              type="button"
              onClick={() => onToggleNotifications(selectedRun)}
              disabled={typeof window !== "undefined" && !("Notification" in window)}
            >
              {selectedRunNotificationsEnabled ? <BellOff size={14} /> : <Bell size={14} />}
              {selectedRunNotificationsEnabled ? "Disable finish notification" : "Enable finish notification"}
            </button>
          ) : null}
        </Metric>
      ) : null}
      <Metric
        label="Speed"
        value={
          <MetricLines
            lines={speedMetricLines(selectedRun, selectedLiveEstimate, selectedSpeedStats)}
          />
        }
      />
    </section>
  );
}

function remainingMetricLines(
  selectedLiveEstimate: { remaining: string; endTime: string } | null,
  selectedPassTiming: CurrentPassTiming | null
) {
  const lines: MetricLine[] = [];
  if (selectedLiveEstimate) {
    lines.push(["All passes", `~${selectedLiveEstimate.remaining}`], ["Finish at", selectedLiveEstimate.endTime]);
  }
  if (selectedLiveEstimate && selectedPassTiming?.remaining && selectedPassTiming.endTime) {
    lines.push("separator");
  }
  if (selectedPassTiming?.remaining && selectedPassTiming.endTime) {
    lines.push(["Current pass", `~${selectedPassTiming.remaining}`], ["Pass finishes", selectedPassTiming.endTime]);
  }
  return lines;
}

function speedMetricLines(
  selectedRun: BenchRun | null,
  selectedLiveEstimate: { expectedTotal: string } | null,
  selectedSpeedStats: { averageTask: string; elapsed: string }
): MetricLine[] {
  const lines: MetricLine[] = [
    ["Per task", selectedSpeedStats.averageTask],
    [statusIsInProgress(selectedRun?.status) ? "Run so far" : "Total run", selectedSpeedStats.elapsed]
  ];
  if (statusIsInProgress(selectedRun?.status)) {
    lines.push(["Expected total", selectedLiveEstimate ? `~${selectedLiveEstimate.expectedTotal}` : "Estimating..."]);
  }
  return lines;
}
