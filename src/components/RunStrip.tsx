import { Check, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { benchmarkOption, runBenchmarkId, runBenchmarkScoring, type BenchmarkId, type BenchRoute, type BenchRun } from "../domain/benchmark";
import { formatTime, pct, progressSegments, runMeanScore, runQueueBadgePosition, runTotal, statusIsLive } from "../domain/runs";
import { BenchmarkCombobox, ModelCombobox } from "./ModelCombobox";

export function RunStrip({
  runs,
  selectedRunId,
  onSelectNew,
  onNavigate,
  onDelete,
  onRemoveFromQueue
}: {
  runs: BenchRun[];
  selectedRunId: string | null;
  onSelectNew: () => void;
  onNavigate: (route: BenchRoute) => void;
  onDelete: (run: BenchRun) => void;
  onRemoveFromQueue: (run: BenchRun) => void;
}) {
  const [benchmarkFilter, setBenchmarkFilter] = useState<BenchmarkId | "">("");
  const [modelFilter, setModelFilter] = useState("");
  const normalizedModelFilter = modelFilter.trim().toLocaleLowerCase();
  const availableModels = Array.from(new Set(runs.map((run) => run.model).filter(Boolean))).sort();
  const filteredRuns = runs.filter((run) => {
    return (!benchmarkFilter || runBenchmarkId(run) === benchmarkFilter)
      && (run.model ?? "").toLocaleLowerCase().includes(normalizedModelFilter);
  });

  return (
    <section className="run-strip">
      <div className="pane-head">Benchmarks</div>
      <div className="run-filters">
        <label>
          <BenchmarkCombobox
            ariaLabel="Filter by benchmark name"
            placeholder="All benchmarks"
            value={benchmarkFilter}
            onChange={setBenchmarkFilter}
          />
        </label>
        <label>
          <ModelCombobox
            ariaLabel="Filter by model"
            models={availableModels}
            placeholder="Model"
            value={modelFilter}
            onChange={setModelFilter}
          />
        </label>
      </div>
      <div className="run-list">
        <div className={selectedRunId === null ? "run-tab new-run-tab active" : "run-tab new-run-tab"}>
          <button className="run-tab-main" type="button" onClick={onSelectNew}>
            <Plus size={16} />
            <strong>New bench</strong>
            <small>Default parameters</small>
          </button>
        </div>
        {filteredRuns.length ? filteredRuns.map((candidate) => {
          const queuePosition = runQueueBadgePosition(candidate);
          const benchmarkName = benchmarkOption(runBenchmarkId(candidate)).label;
          const total = runTotal(candidate);
          const progress = progressSegments(candidate);
          const gradedScoring = runBenchmarkScoring(candidate) === "graded";
          const score = gradedScoring ? runMeanScore(candidate) : candidate.liveScore;
          const completed = candidate.status === "completed";
          const tabClasses = [
            "run-tab",
            candidate.id === selectedRunId ? "active" : "",
            queuePosition ? "queued" : ""
          ].filter(Boolean).join(" ");
          return (
            <div className={tabClasses} key={candidate.id}>
              <button className="run-tab-main" type="button" onClick={() => onNavigate({ view: "run", id: candidate.id })}>
                <span className={`status-dot ${statusIsLive(candidate.status) ? "live" : ""} ${completed ? "completed" : ""}`}>
                  {completed ? <Check aria-hidden="true" size={9} strokeWidth={3} /> : null}
                </span>
                <strong>{candidate.model || "model"}</strong>
                <small className="run-tab-benchmark">{benchmarkName}</small>
                <small className="run-tab-metrics" title={`Started ${formatTime(candidate.createdAt)}`}>
                  <span>{candidate.status}</span>
                  <span className="run-tab-count">{candidate.completed}/{total}</span>
                  <b>score {pct(score)}</b>
                </small>
                <span
                  aria-label={`Progress: ${candidate.completed} of ${total} tasks, ${pct(score)} score`}
                  className="run-tab-progress"
                  role="img"
                >
                  <span className="run-tab-progress-failed" style={{ width: `${progress.failed}%` }} />
                  <span className="run-tab-progress-passed" style={{ width: `${progress.passed}%` }} />
                  <span className="run-tab-progress-remaining" style={{ width: `${progress.remaining}%` }} />
                </span>
              </button>
              {queuePosition ? (
                <button
                  aria-label={`Remove benchmark run ${candidate.model || candidate.id} from queue (position ${queuePosition})`}
                  className="queue-badge"
                  title={`Queued #${queuePosition} — remove from queue`}
                  type="button"
                  onClick={() => onRemoveFromQueue(candidate)}
                >
                  <span className="queue-badge-position">{queuePosition}</span>
                  <X className="queue-badge-remove" size={13} />
                </button>
              ) : null}
              <button
                aria-label={`Delete benchmark run ${candidate.model || candidate.id}`}
                className="run-delete"
                title="Delete benchmark run"
                type="button"
                onClick={() => onDelete(candidate)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          );
        }) : (
          <p className="empty-copy">
            {runs.length ? "No benchmark runs match these filters." : "No benchmark runs recorded yet."}
          </p>
        )}
      </div>
    </section>
  );
}
