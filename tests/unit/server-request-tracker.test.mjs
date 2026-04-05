import { describe, expect, test } from "vitest";
import trackerModule from "../../server-request-tracker.js";

const { ServerRequestTracker } = trackerModule;

describe("ServerRequestTracker", () => {
  test("infers threadId for approval requests from prior turn events", () => {
    const tracker = new ServerRequestTracker();

    tracker.observeNotification({
      method: "turn/started",
      params: {
        threadId: "thread-123",
        turn: { id: "turn-456" },
      },
    });

    const normalized = tracker.normalizeRequest({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        turnId: "turn-456",
        command: "rm -rf /tmp/example",
      },
    });

    expect(normalized.params.threadId).toBe("thread-123");
  });

  test("infers threadId for approval requests from prior item events", () => {
    const tracker = new ServerRequestTracker();

    tracker.observeNotification({
      method: "item/started",
      params: {
        threadId: "thread-abc",
        turnId: "turn-def",
        item: { id: "item-ghi" },
      },
    });

    const normalized = tracker.normalizeRequest({
      id: 100,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-ghi",
        reason: "Approve file changes?",
      },
    });

    expect(normalized.params.threadId).toBe("thread-abc");
  });

  test("preserves explicit threadId on incoming requests", () => {
    const tracker = new ServerRequestTracker();

    const request = {
      id: 101,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-explicit",
        turnId: "turn-other",
      },
    };

    expect(tracker.normalizeRequest(request)).toBe(request);
  });

  test("tracks repeated request ids so duplicate pending tool calls are visible", () => {
    const tracker = new ServerRequestTracker();

    const first = tracker.observeRequest({ id: 42 });
    expect(first).toMatchObject({
      requestId: "42",
      occurrence: 1,
      isDuplicate: false,
      isPendingReplay: false,
      wasResolved: false,
    });

    const second = tracker.observeRequest({ id: 42 });
    expect(second).toMatchObject({
      requestId: "42",
      occurrence: 2,
      isDuplicate: true,
      isPendingReplay: true,
      wasResolved: false,
    });

    tracker.resolveRequest(42);

    const third = tracker.observeRequest({ id: 42 });
    expect(third).toMatchObject({
      requestId: "42",
      occurrence: 3,
      isDuplicate: true,
      isPendingReplay: false,
      wasResolved: true,
    });
  });
});
