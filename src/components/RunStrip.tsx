import { Plus, Trash2, X } from "lucide-react";
import type { BenchRoute, BenchRun } from "../domain/benchmark";
import { formatTime, runQueueBadgePosition, runTotal, statusIsLive } from "../domain/runs";

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
  return (
    <section className="run-strip">
      <div className="pane-head">Benchmarks</div>
      <div className="run-list">
        <div className={selectedRunId === null ? "run-tab new-run-tab active" : "run-tab new-run-tab"}>
          <button className="run-tab-main" type="button" onClick={onSelectNew}>
            <Plus size={16} />
            <strong>New bench</strong>
            <small>Default parameters</small>
          </button>
        </div>
        {runs.length ? runs.map((candidate) => {
          const queuePosition = runQueueBadgePosition(candidate);
          const tabClasses = [
            "run-tab",
            candidate.id === selectedRunId ? "active" : "",
            queuePosition ? "queued" : ""
          ].filter(Boolean).join(" ");
          return (
            <div className={tabClasses} key={candidate.id}>
              <button className="run-tab-main" type="button" onClick={() => onNavigate({ view: "run", id: candidate.id })}>
                <span className={`status-dot ${statusIsLive(candidate.status) ? "live" : ""}`} />
                <strong>{candidate.model || "model"}</strong>
                <small>{candidate.status} · {candidate.completed}/{runTotal(candidate)} · {formatTime(candidate.createdAt)}</small>
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
        }) : <p className="empty-copy">No benchmark runs recorded yet.</p>}
      </div>
    </section>
  );
}
