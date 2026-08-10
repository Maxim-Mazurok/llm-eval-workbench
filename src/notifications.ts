export const NOTIFY_DISABLED_RUNS_STORAGE_KEY = "llmEval.notify.disabledRuns";

export type RunNotificationSummary = {
  id: string;
  status: string;
  benchmark?: string;
  model?: string;
  total?: number;
  selectedIndices?: number[];
  passed: number;
};

const notificationBenchmarkLabels: Record<string, string> = {
  humaneval: "HumanEval",
  "bbeh-mini": "BBEH Mini",
  "bbeh-mini-official": "BBEH Mini (official)",
  "bbeh-full": "BBEH",
  "bbeh-full-official": "BBEH (official)"
};

export function notificationBenchmarkLabel(benchmark?: string) {
  return notificationBenchmarkLabels[benchmark ?? "humaneval"] ?? "Benchmark";
}

export function runTotal(run: Pick<RunNotificationSummary, "total" | "selectedIndices">) {
  return run.total || run.selectedIndices?.length || 164;
}

export function isTerminalNotificationStatus(status?: string) {
  return status === "completed" || status === "cancelled" || status === "error" || status === "interrupted";
}

export function notificationEventIsTerminal(eventType: string) {
  return eventType === "done" || eventType === "error";
}

export function browserNotificationsAvailable(win: Window = window) {
  return "Notification" in win;
}

function notificationApi(win: Window) {
  return browserNotificationsAvailable(win) ? (win as Window & { Notification: typeof Notification }).Notification : null;
}

async function notificationServiceWorkerRegistration(win: Window) {
  const serviceWorker = win.navigator?.serviceWorker;
  if (!serviceWorker) return null;
  const registration = await serviceWorker.register("/notification-worker.js");
  return registration.active ? registration : serviceWorker.ready;
}

export function readNotificationsEnabled(win: Window = window) {
  const api = notificationApi(win);
  return Boolean(api && api.permission === "granted");
}

export async function requestNotificationsEnabled(win: Window = window) {
  const api = notificationApi(win);
  if (!api) return false;
  const permission = api.permission === "granted"
    ? "granted"
    : await api.requestPermission();
  if (permission !== "granted") return false;
  notificationServiceWorkerRegistration(win).catch(() => undefined);
  return true;
}

export function readDisabledRunNotificationIds(win: Window = window) {
  const raw = win.localStorage.getItem(NOTIFY_DISABLED_RUNS_STORAGE_KEY);
  if (!raw) return new Set<string>();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set<string>();
  }
}

export function notificationsEnabledForRun(runId: string, disabledRunIds: Set<string>) {
  return !disabledRunIds.has(runId);
}

export function writeRunNotificationPreference(runId: string, enabled: boolean, win: Window = window) {
  const disabledRunIds = readDisabledRunNotificationIds(win);
  if (enabled) {
    disabledRunIds.delete(runId);
  } else {
    disabledRunIds.add(runId);
  }
  win.localStorage.setItem(
    NOTIFY_DISABLED_RUNS_STORAGE_KEY,
    JSON.stringify([...disabledRunIds].sort((left, right) => left.localeCompare(right)))
  );
  return disabledRunIds;
}

export function buildRunNotification(run: RunNotificationSummary, eventType = run.status) {
  const finished = eventType === "done" || run.status === "completed";
  const benchmarkLabel = notificationBenchmarkLabel(run.benchmark);
  return {
    title: finished ? `${benchmarkLabel} run finished` : `${benchmarkLabel} run stopped`,
    options: {
      body: `${run.model || "model"} · ${run.passed}/${runTotal(run)} passed · ${run.status}`,
      tag: run.id
    }
  };
}

export async function dispatchRunNotification(
  run: RunNotificationSummary,
  eventType: string,
  notifiedRunIds: Set<string>,
  win: Window = window
) {
  const api = notificationApi(win);
  if (!api || api.permission !== "granted") return false;
  if (notifiedRunIds.has(run.id)) return false;
  notifiedRunIds.add(run.id);
  const notification = buildRunNotification(run, eventType);
  try {
    const registration = await notificationServiceWorkerRegistration(win);
    if (registration) {
      await registration.showNotification(notification.title, notification.options);
      return true;
    }
    new api(notification.title, notification.options);
    return true;
  } catch {
    try {
      new api(notification.title, notification.options);
      return true;
    } catch {
      notifiedRunIds.delete(run.id);
      return false;
    }
  }
}
