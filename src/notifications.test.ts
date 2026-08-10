import { describe, expect, it, vi } from "vitest";
import {
  buildRunNotification,
  dispatchRunNotification,
  isTerminalNotificationStatus,
  notificationsEnabledForRun,
  notificationEventIsTerminal,
  readDisabledRunNotificationIds,
  requestNotificationsEnabled,
  writeRunNotificationPreference
} from "./notifications";

function notificationWindow(permission: NotificationPermission = "granted") {
  const calls: Array<{ title: string; options?: NotificationOptions }> = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => permission);

    constructor(title: string, options?: NotificationOptions) {
      calls.push({ title, options });
    }
  }
  const storage = new Map<string, string>();
  const win = {
    Notification: FakeNotification,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    }
  } as unknown as Window;
  return { win, calls, storage, FakeNotification };
}

describe("notifications", () => {
  it("builds a completion notification with run totals", () => {
    expect(buildRunNotification({
      id: "run-1",
      status: "completed",
      model: "demo-model",
      passed: 3,
      total: 5
    }, "done")).toEqual({
      title: "HumanEval run finished",
      options: {
        body: "demo-model · 3/5 passed · completed",
        tag: "run-1"
      }
    });
  });

  it("classifies terminal statuses and SSE terminal events", () => {
    expect(isTerminalNotificationStatus("completed")).toBe(true);
    expect(isTerminalNotificationStatus("cancelled")).toBe(true);
    expect(isTerminalNotificationStatus("running")).toBe(false);
    expect(notificationEventIsTerminal("done")).toBe(true);
    expect(notificationEventIsTerminal("task-finished")).toBe(false);
  });

  it("treats granted browser permission as notifications enabled", async () => {
    const { win, FakeNotification } = notificationWindow("granted");

    await expect(requestNotificationsEnabled(win)).resolves.toBe(true);

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("stores disabled notification preferences per run id", () => {
    const { win, storage } = notificationWindow("granted");

    expect(notificationsEnabledForRun("run-1", readDisabledRunNotificationIds(win))).toBe(true);

    writeRunNotificationPreference("run-1", false, win);
    expect(storage.get("llmEval.notify.disabledRuns")).toBe("[\"run-1\"]");
    expect(notificationsEnabledForRun("run-1", readDisabledRunNotificationIds(win))).toBe(false);

    writeRunNotificationPreference("run-1", true, win);
    expect(storage.get("llmEval.notify.disabledRuns")).toBe("[]");
    expect(notificationsEnabledForRun("run-1", readDisabledRunNotificationIds(win))).toBe(true);
  });

  it("dispatches only once per run id", async () => {
    const { win, calls } = notificationWindow("granted");
    const notifiedRunIds = new Set<string>();
    const run = {
      id: "run-1",
      status: "completed",
      model: "demo-model",
      passed: 1,
      selectedIndices: [0, 1]
    };

    await expect(dispatchRunNotification(run, "done", notifiedRunIds, win)).resolves.toBe(true);
    await expect(dispatchRunNotification(run, "done", notifiedRunIds, win)).resolves.toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "HumanEval run finished",
      options: { body: "demo-model · 1/2 passed · completed", tag: "run-1" }
    });
  });

  it("prefers persistent service worker notifications", async () => {
    const { win, calls } = notificationWindow("granted");
    const showNotification = vi.fn(async () => undefined);
    const registration = { active: {}, showNotification };
    const register = vi.fn(async () => registration);
    Object.defineProperty(win, "navigator", {
      value: {
        serviceWorker: {
          register,
          ready: Promise.resolve(registration)
        }
      }
    });

    const dispatched = await dispatchRunNotification({
      id: "run-1",
      status: "completed",
      model: "demo-model",
      passed: 1,
      total: 1
    }, "done", new Set(), win);

    expect(dispatched).toBe(true);
    expect(register).toHaveBeenCalledWith("/notification-worker.js");
    expect(showNotification).toHaveBeenCalledWith(
      "HumanEval run finished",
      expect.objectContaining({ tag: "run-1" })
    );
    expect(calls).toHaveLength(0);
  });

  it("does not dispatch when permission is not granted", async () => {
    const { win, calls } = notificationWindow("denied");

    await expect(dispatchRunNotification({
      id: "run-1",
      status: "completed",
      passed: 1
    }, "done", new Set(), win)).resolves.toBe(false);

    expect(calls).toHaveLength(0);
  });
});
