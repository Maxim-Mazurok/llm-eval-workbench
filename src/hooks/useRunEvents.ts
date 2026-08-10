import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { BENCH_API, type BenchRun, type EventEnvelope, type TokenEvent } from "../domain/benchmark";
import { recordEventSourceMeasurement, textByteLength } from "../domain/performanceMetrics";
import { updateRunInPlace } from "../domain/runs";
import { notificationEventIsTerminal } from "../notifications";

type UseRunEventsOptions = {
  selectedRunId: string | null;
  setRuns: Dispatch<SetStateAction<BenchRun[]>>;
  setEvents: Dispatch<SetStateAction<EventEnvelope[]>>;
  setTokens: Dispatch<SetStateAction<TokenEvent[]>>;
  setTaskStartedAtByRun: Dispatch<SetStateAction<Record<string, number>>>;
  rememberLiveRuns: (runs: BenchRun[]) => void;
  notifyRunFinished: (run: BenchRun, eventType: string) => void;
  loadRuns: () => Promise<void>;
};

export function useRunEvents({
  selectedRunId,
  setRuns,
  setEvents,
  setTokens,
  setTaskStartedAtByRun,
  rememberLiveRuns,
  notifyRunFinished,
  loadRuns
}: UseRunEventsOptions) {
  const sourcesRef = useRef<Map<string, EventSource>>(new Map());
  const selectedRunIdRef = useRef<string | null>(null);
  const lastTokenAtByRunRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => () => {
    for (const source of sourcesRef.current.values()) source.close();
    sourcesRef.current.clear();
  }, []);

  function closeRunEvents(runId: string) {
    sourcesRef.current.get(runId)?.close();
    sourcesRef.current.delete(runId);
  }

  function connectEvents(runId: string) {
    if (sourcesRef.current.has(runId)) return;
    const source = new EventSource(`${BENCH_API}/api/runs/${runId}/events`);
    sourcesRef.current.set(runId, source);
    const handle = (message: MessageEvent) => {
      const messageBytes = textByteLength(String(message.data));
      const event = JSON.parse(message.data) as EventEnvelope;
      let tokenGapMilliseconds: number | null | undefined;
      if (event.type === "token") {
        const now = performance.now();
        const lastTokenAt = lastTokenAtByRunRef.current.get(runId);
        tokenGapMilliseconds = lastTokenAt === undefined ? null : now - lastTokenAt;
        lastTokenAtByRunRef.current.set(runId, now);
      }
      recordEventSourceMeasurement({
        runId,
        eventType: event.type,
        messageBytes,
        tokenChannel: event.type === "token" && typeof event.data.channel === "string" ? event.data.channel : undefined,
        tokenTextBytes: event.type === "token" && typeof event.data.text === "string" ? textByteLength(event.data.text) : undefined,
        tokenGapMilliseconds
      });
      const maybeSummary = event.data.summary as BenchRun | undefined;
      if (maybeSummary) {
        rememberLiveRuns([maybeSummary]);
        setRuns((previous) => updateRunInPlace(previous, maybeSummary));
      }
      const currentSelectedRunId = selectedRunIdRef.current;
      if (runId === currentSelectedRunId) {
        setEvents((prev) => [...prev, event]);
        if (event.type === "task-started") {
          const timestamp = new Date(event.at).getTime();
          if (Number.isFinite(timestamp)) {
            setTaskStartedAtByRun((previous) => ({ ...previous, [runId]: timestamp }));
          }
        }
        if (event.type === "token") {
          const data = event.data as unknown as TokenEvent;
          setTokens((prev) => [...prev, data]);
        }
        if (event.type === "task-finished") refreshSelectedRun(runId);
      }
      if (notificationEventIsTerminal(event.type)) {
        if (maybeSummary) notifyRunFinished(maybeSummary, event.type);
        closeRunEvents(runId);
        loadRuns().catch(() => undefined);
      }
      // A run starting means the queue advanced (the previous active run may
      // have ended without a visible terminal event, e.g. it was deleted);
      // refetch so every queued run's badge position renumbers.
      if (event.type === "run-started") loadRuns().catch(() => undefined);
    };
    for (const name of ["run-started", "task-started", "prompt", "token", "raw-delta", "code-extracted", "task-finished", "done", "error"]) {
      source.addEventListener(name, handle);
    }
    source.onerror = () => {
      closeRunEvents(runId);
      loadRuns().catch(() => undefined);
    };
  }

  function refreshSelectedRun(runId: string) {
    fetch(`${BENCH_API}/api/runs/${runId}`)
      .then(async (response) => {
        const json = await response.json();
        if (response.ok) {
          setRuns((previous) => updateRunInPlace(previous, json));
          if (runId === selectedRunIdRef.current) {
            const refreshedEvents = (json.events as EventEnvelope[] | undefined) ?? [];
            const refreshedTokens = refreshedEvents
              .filter((refreshedEvent) => refreshedEvent.type === "token")
              .map((refreshedEvent) => refreshedEvent.data as unknown as TokenEvent);
            setEvents(refreshedEvents);
            setTokens(refreshedTokens);
          }
        }
      })
      .catch(() => undefined);
  }

  return { closeRunEvents, connectEvents };
}
