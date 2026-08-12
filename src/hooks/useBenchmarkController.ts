import { useEffect, useMemo, useRef, useState } from "react";
import {
  browserNotificationsAvailable,
  dispatchRunNotification,
  isTerminalNotificationStatus,
  notificationsEnabledForRun,
  readDisabledRunNotificationIds,
  requestNotificationsEnabled,
  writeRunNotificationPreference
} from "../notifications";
import {
  BENCH_API,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  readBenchRoute,
  routePath,
  type BenchRun,
  type BenchRoute,
  type EventEnvelope,
  type TokenEvent
} from "../domain/benchmark";
import { thinkingInCommentsStats, thinkingResultNumbers } from "../domain/comments";
import { currentPassTiming } from "../domain/passTiming";
import {
  anyRunLive,
  currentTaskStartedAtMs,
  formatTime,
  liveEstimate,
  mergeRunList,
  normalizeParallelTasks,
  normalizePassCount,
  parseJsonObject,
  progressSegments,
  runCanResume,
  readSidebarCollapsed,
  resultNumbers,
  scoreRange,
  speedStats,
  statusIsLive,
  updateRunInPlace
} from "../domain/runs";
import {
  promptInfoByAttempt as derivePromptInfoByAttempt,
  taskGroupsFromRun,
  tokensByAttempt as deriveTokensByAttempt
} from "../domain/tasks";
import {
  initializeBrowserPerformanceMetrics,
  jsonByteLength,
  performanceDebugIsEnabled,
  recordSelectedRunFetchMeasurement,
  recordStateMeasurement
} from "../domain/performanceMetrics";
import { useRunEvents } from "./useRunEvents";
import { useBenchForm } from "./useBenchForm";
import { useBenchmarkDefaults } from "./useBenchmarkDefaults";

export function useBenchmarkController() {
  const initialRoute = useMemo(() => readBenchRoute(), []);
  const performanceMetricsEnabled = useMemo(() => performanceDebugIsEnabled(window), []);
  const systemPromptByBenchmark = useBenchmarkDefaults();
  const form = useBenchForm(systemPromptByBenchmark);
  const {
    benchmark, baseUrl, apiKey, model, maxOutputTokens, thinkingEnabled, thinkingBudget, timeoutSeconds, parallelTasks,
    passCount, adaptiveRepetitionPenalty, repetitionPenalty, commentSignalThreshold, sampleLimit, startIndex, testNumbers,
    systemPrompt, promptTemplate, extraBody, setBenchmark, setBaseUrl, setApiKey, setModel,
    setMaxOutputTokens, setThinkingEnabled, setThinkingBudget, setTimeoutSeconds, setParallelTasks, setPassCount, setAdaptiveRepetitionPenalty, setRepetitionPenalty,
    setCommentSignalThreshold, setSampleLimit, setStartIndex, setTestNumbers,
    setSystemPrompt, setPromptTemplate, setExtraBody, resetRunConfig, loadRunConfig
  } = form;
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [route, setRoute] = useState<BenchRoute>(initialRoute);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    initialRoute.view === "run" ? initialRoute.id : null
  );
  const [tokens, setTokens] = useState<TokenEvent[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    typeof window !== "undefined" ? readSidebarCollapsed(window) : false
  ));
  const [selectedPassByTask, setSelectedPassByTask] = useState<Record<string, number>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [taskStartedAtByRun, setTaskStartedAtByRun] = useState<Record<string, number>>({});
  const [disabledNotificationRunIds, setDisabledNotificationRunIds] = useState(() => (
    typeof window !== "undefined" ? readDisabledRunNotificationIds(window) : new Set<string>()
  ));
  const notifiedRunsRef = useRef<Set<string>>(new Set());
  const observedLiveRunsRef = useRef<Set<string>>(new Set());
  const disabledNotificationRunIdsRef = useRef(disabledNotificationRunIds);

  const selectedRun = useMemo(
    () => runs.find((candidate) => candidate.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );
  const selectedScoreRange = useMemo(() => scoreRange(selectedRun), [selectedRun]);
  const selectedProgressSegments = useMemo(() => progressSegments(selectedRun), [selectedRun]);
  const selectedTaskStartedAtMs = selectedRun?.id ? taskStartedAtByRun[selectedRun.id] : null;
  const selectedLiveEstimate = useMemo(
    () => liveEstimate(selectedRun, events, nowMs, selectedTaskStartedAtMs),
    [events, nowMs, selectedRun, selectedTaskStartedAtMs]
  );
  const selectedPassTiming = useMemo(
    () => currentPassTiming(selectedRun, events, nowMs, selectedTaskStartedAtMs),
    [events, nowMs, selectedRun, selectedTaskStartedAtMs]
  );
  const selectedSpeedStats = useMemo(
    () => speedStats(selectedRun, events, nowMs, selectedTaskStartedAtMs),
    [events, nowMs, selectedRun, selectedTaskStartedAtMs]
  );
  const selectedThinkingStats = useMemo(
    () => thinkingInCommentsStats(selectedRun?.results ?? [], commentSignalThreshold),
    [commentSignalThreshold, selectedRun]
  );
  const selectedRunNotificationsEnabled = selectedRun
    ? notificationsEnabledForRun(selectedRun.id, disabledNotificationRunIds)
    : true;
  const queueActive = useMemo(() => anyRunLive(runs), [runs]);

  // A backend that predates the run queue starts every POSTed run
  // immediately and its summaries carry no queue fields. When the UI promised
  // "Add to queue" but the server can't queue, silence would look exactly like
  // a broken queue — say what actually happened and how to fix it.
  function warnIfBackendCannotQueue(runSummary: Record<string, unknown>) {
    if (!queueActive || "queuePosition" in runSummary) return;
    setError(
      "The benchmark server is running an older version without run queueing, "
      + "so this run started immediately instead of waiting. Restart the "
      + "benchmark server (npm run dev:bench) once the current run finishes."
    );
  }

  const tokensByAttempt = useMemo(() => deriveTokensByAttempt(tokens), [tokens]);

  const promptInfoByAttempt = useMemo(
    () => derivePromptInfoByAttempt(events, selectedRun),
    [events, selectedRun]
  );

  const taskGroups = useMemo(
    () => taskGroupsFromRun(events, selectedRun, tokensByAttempt, promptInfoByAttempt),
    [events, promptInfoByAttempt, selectedRun, tokensByAttempt]
  );

  useEffect(() => {
    initializeBrowserPerformanceMetrics(performanceMetricsEnabled, window);
  }, [performanceMetricsEnabled]);

  useEffect(() => {
    if (!performanceMetricsEnabled) return;
    recordStateMeasurement({
      runId: selectedRun?.id ?? null,
      eventCount: events.length,
      tokenCount: tokens.length,
      tokensByAttemptCount: tokensByAttempt.size,
      promptInfoByAttemptCount: promptInfoByAttempt.size,
      taskGroupCount: taskGroups.length,
      attemptCount: taskGroups.reduce((totalAttempts, taskGroup) => totalAttempts + taskGroup.attempts.length, 0),
      openTaskCount: Object.values(expanded).filter(Boolean).length
    });
  }, [events.length, expanded, performanceMetricsEnabled, promptInfoByAttempt, selectedRun?.id, taskGroups, tokens.length, tokensByAttempt]);


  useEffect(() => {
    const canonicalPath = routePath(route);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(null, "", canonicalPath);
    }
    const handlePopState = () => {
      setError(null);
      setRoute(readBenchRoute());
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (route.view === "run") {
      setSelectedRunId(route.id);
      return;
    }
    setSelectedRunId(null);
    setTokens([]);
    setEvents([]);
    resetRunConfig();
  }, [route]);

  useEffect(() => {
    disabledNotificationRunIdsRef.current = disabledNotificationRunIds;
  }, [disabledNotificationRunIds]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!statusIsLive(selectedRun?.status)) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selectedRun?.status]);

  async function toggleNotificationsForRun(run: BenchRun) {
    if (!browserNotificationsAvailable(window)) {
      setError("This browser does not support web notifications.");
      return;
    }
    const currentlyEnabled = notificationsEnabledForRun(run.id, disabledNotificationRunIdsRef.current);
    if (currentlyEnabled) {
      setDisabledNotificationRunIds(writeRunNotificationPreference(run.id, false, window));
      return;
    }
    const enabled = await requestNotificationsEnabled(window);
    if (enabled) {
      setDisabledNotificationRunIds(writeRunNotificationPreference(run.id, true, window));
    }
    if (!enabled) setError("Notifications were not enabled.");
  }

  function rememberLiveRuns(nextRuns: BenchRun[]) {
    for (const run of nextRuns) {
      if (statusIsLive(run.status)) observedLiveRunsRef.current.add(run.id);
    }
  }

  function notifyRunFinished(run: BenchRun, eventType: string) {
    if (!notificationsEnabledForRun(run.id, disabledNotificationRunIdsRef.current)) return;
    dispatchRunNotification(run, eventType, notifiedRunsRef.current, window);
  }

  function notifyObservedTerminalRuns(nextRuns: BenchRun[]) {
    for (const run of nextRuns) {
      if (!observedLiveRunsRef.current.has(run.id)) continue;
      if (!isTerminalNotificationStatus(run.status)) continue;
      notifyRunFinished(run, run.status);
    }
  }

  const { closeRunEvents, connectEvents } = useRunEvents({
    selectedRunId,
    setRuns,
    setEvents,
    setTokens,
    setTaskStartedAtByRun,
    rememberLiveRuns,
    notifyRunFinished,
    loadRuns: () => loadRuns()
  });

  function navigateTo(routeTarget: BenchRoute, replace = false) {
    const path = routePath(routeTarget);
    if (window.location.pathname !== path) {
      if (replace) {
        window.history.replaceState(null, "", path);
      } else {
        window.history.pushState(null, "", path);
      }
    }
    setRoute(routeTarget);
  }

  async function loadRuns(selectLatest = false) {
    const response = await fetch(`${BENCH_API}/api/runs`);
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || "Failed to load runs");
    const nextRuns = json.runs as BenchRun[];
    rememberLiveRuns(nextRuns);
    notifyObservedTerminalRuns(nextRuns);
    setRuns((previous) => mergeRunList(previous, nextRuns));
    if (selectLatest) {
      const latestRun = nextRuns[0];
      navigateTo(latestRun ? { view: "run", id: latestRun.id } : { view: "new" });
    } else if (selectedRunId && !nextRuns.some((run) => run.id === selectedRunId)) {
      navigateTo({ view: "new" });
    }
    for (const run of nextRuns.filter((candidate) => statusIsLive(candidate.status))) {
      connectEvents(run.id);
    }
  }

  useEffect(() => {
    loadRuns().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    });
  }, []);

  function selectNewBench() {
    setError(null);
    navigateTo({ view: "new" });
  }

  function selectRun(routeTarget: BenchRoute) {
    setError(null);
    navigateTo(routeTarget);
  }

  useEffect(() => {
    if (!selectedRunId) {
      setTokens([]);
      setEvents([]);
      return;
    }
    const startedAt = performance.now();
    fetch(`${BENCH_API}/api/runs/${selectedRunId}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error || "Failed to load run");
        const runEvents = (json.events as EventEnvelope[] | undefined) ?? [];
        const tokenEvents = runEvents.filter((event) => event.type === "token");
        if (performanceMetricsEnabled) {
          const contentLength = Number(response.headers.get("content-length"));
          recordSelectedRunFetchMeasurement({
            runId: String(json.id || selectedRunId),
            durationMilliseconds: performance.now() - startedAt,
            contentLengthBytes: Number.isFinite(contentLength) ? contentLength : null,
            payloadBytes: jsonByteLength(json),
            resultCount: Array.isArray(json.results) ? json.results.length : 0,
            eventCount: runEvents.length,
            tokenEventCount: tokenEvents.length
          });
        }
        setRuns((previous) => updateRunInPlace(previous, json));
        loadRunConfig(json);
        if (statusIsLive(json.status)) connectEvents(json.id);
        const latestTaskStartedAtMs = currentTaskStartedAtMs(json, runEvents);
        if (latestTaskStartedAtMs) {
          setTaskStartedAtByRun((previous) => ({ ...previous, [json.id]: latestTaskStartedAtMs }));
        }
        setEvents(runEvents);
        setTokens(tokenEvents.map((event) => event.data as unknown as TokenEvent));
      })
      .catch((runError) => setError(runError instanceof Error ? runError.message : String(runError)));
  }, [selectedRunId]);

  function currentRunConfig() {
    return {
      benchmark,
      baseUrl,
      apiKey,
      model,
      maxOutputTokens,
      thinkingEnabled,
      thinkingBudget,
      timeoutSeconds,
      parallelTasks: normalizeParallelTasks(parallelTasks),
      passCount: normalizePassCount(passCount),
      adaptiveRepetitionPenalty,
      repetitionPenalty,
      sampleLimit,
      startIndex,
      testNumbers,
      systemPrompt,
      promptTemplate,
      temperature: 0,
      extraBody: parseJsonObject(extraBody)
    };
  }

  async function startRun() {
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentRunConfig())
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to start run");
      warnIfBackendCannotQueue(json);
      setRuns((previous) => updateRunInPlace(previous, json));
      navigateTo({ view: "run", id: json.id });
      setTokens([]);
      setEvents([]);
      setTaskStartedAtByRun((previous) => {
        const { [json.id]: _ignored, ...rest } = previous;
        return rest;
      });
      if (browserNotificationsAvailable(window)) {
        requestNotificationsEnabled(window).then((enabled) => {
          if (!enabled) setError("Notifications were not enabled.");
        }).catch(() => undefined);
      }
      observedLiveRunsRef.current.add(json.id);
      connectEvents(json.id);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    }
  }

  async function cancelRun() {
    if (!selectedRun || !statusIsLive(selectedRun.status)) return;
    await fetch(`${BENCH_API}/api/runs/${selectedRun.id}/cancel`, { method: "POST" });
    await loadRuns();
  }

  // The queue badge's X. Cancelling a queued run is exactly "take it out of
  // line": the server dequeues it and the run stays around as "cancelled",
  // resumable or deletable later.
  async function removeRunFromQueue(run: BenchRun) {
    if (run.status !== "queued") return;
    setError(null);
    // The server answers a queued cancel with a terminal "error" event, which
    // would otherwise fire a "run stopped" OS notification for a deliberate
    // one-click dequeue.
    const alreadyNotified = notifiedRunsRef.current.has(run.id);
    notifiedRunsRef.current.add(run.id);
    try {
      const response = await fetch(`${BENCH_API}/api/runs/${run.id}/cancel`, { method: "POST" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Failed to remove run from queue");
      await loadRuns();
    } catch (removeError) {
      if (!alreadyNotified) notifiedRunsRef.current.delete(run.id);
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  }

  async function resumeRun() {
    if (!selectedRun || !runCanResume(selectedRun)) return;
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/runs/${selectedRun.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(currentRunConfig())
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Failed to resume run");
      warnIfBackendCannotQueue(json);
      // A run that already notified once (stopped, or removed from the queue)
      // must notify again when this fresh attempt reaches a terminal state.
      notifiedRunsRef.current.delete(json.id);
      closeRunEvents(json.id);
      setEvents([]);
      setTokens([]);
      setTaskStartedAtByRun((previous) => {
        const { [json.id]: _ignored, ...rest } = previous;
        return rest;
      });
      setRuns((previous) => updateRunInPlace(previous, json));
      observedLiveRunsRef.current.add(json.id);
      connectEvents(json.id);
      await loadRuns();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError));
    }
  }

  async function deleteRun(run: BenchRun) {
    const label = `${run.model || "model"} · ${formatTime(run.createdAt)}`;
    if (!window.confirm(`Delete benchmark run?\n\n${label}\n\nThis removes its saved artifacts from disk.`)) return;
    setError(null);
    try {
      const response = await fetch(`${BENCH_API}/api/runs/${run.id}`, { method: "DELETE" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Failed to delete run");
      closeRunEvents(run.id);
      if (selectedRunId === run.id) {
        navigateTo({ view: "new" });
        setTokens([]);
        setEvents([]);
      }
      await loadRuns();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function copyNumbers(status: "pass" | "partial" | "fail" | "error" | "loop") {
    const text = resultNumbers(selectedRun, status);
    await navigator.clipboard.writeText(text);
  }

  async function copyThinkingNumbers(flagged: boolean) {
    const text = thinkingResultNumbers(selectedRun, flagged, commentSignalThreshold);
    await navigator.clipboard.writeText(text);
  }

  return {
    benchmark,
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    thinkingEnabled,
    thinkingBudget,
    timeoutSeconds,
    parallelTasks,
    passCount,
    adaptiveRepetitionPenalty,
    repetitionPenalty,
    sampleLimit,
    startIndex,
    testNumbers,
    systemPrompt,
    promptTemplate,
    extraBody,
    runs,
    selectedRunId,
    selectedRun,
    queueActive,
    selectedScoreRange,
    selectedProgressSegments,
    selectedThinkingStats,
    selectedRunNotificationsEnabled,
    selectedLiveEstimate,
    selectedPassTiming,
    selectedSpeedStats,
    tokensByAttempt,
    promptInfoByAttempt,
    taskGroups,
    error,
    expanded,
    sidebarCollapsed,
    selectedPassByTask,
    commentSignalThreshold,
    currentTimeMilliseconds: nowMs,
    setBenchmark,
    setBaseUrl,
    setApiKey,
    setModel,
    setMaxOutputTokens,
    setThinkingEnabled,
    setThinkingBudget,
    setTimeoutSeconds,
    setParallelTasks,
    setPassCount,
    setAdaptiveRepetitionPenalty,
    setRepetitionPenalty,
    setSampleLimit,
    setStartIndex,
    setTestNumbers,
    setSystemPrompt,
    setPromptTemplate,
    setExtraBody,
    setExpanded,
    setSidebarCollapsed,
    setSelectedPassByTask,
    setCommentSignalThreshold,
    toggleNotificationsForRun,
    selectRun,
    selectNewBench,
    startRun,
    cancelRun,
    resumeRun,
    deleteRun,
    removeRunFromQueue,
    copyNumbers,
    copyThinkingNumbers,
  };
}
