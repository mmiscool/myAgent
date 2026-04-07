import { describe, expect, test, vi } from "vitest";
import threadActionUtilsModule from "../../thread-action-utils.js";

const { createThreadActionHelpers } = threadActionUtilsModule;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactObject(input) {
  const output = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    output[key] = value;
  }

  return output;
}

describe("thread action utils", () => {
  test("retries compact after resuming a persisted thread", async () => {
    const bridge = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error("thread not found: thread-123"))
        .mockResolvedValueOnce({ thread: { cwd: "/repo" } })
        .mockResolvedValueOnce({ thread: { id: "thread-123" } })
        .mockResolvedValueOnce({ ok: true }),
    };
    const findProjectByCwd = vi.fn().mockResolvedValue({
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      defaultPersonality: "pragmatic",
    });
    const buildThreadConfig = vi.fn().mockReturnValue({
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      personality: "pragmatic",
    });
    const helpers = createThreadActionHelpers({
      bridge,
      findProjectByCwd,
      buildThreadConfig,
      cleanString,
      compactObject,
    });

    const result = await helpers.requestThreadActionWithResumeRetry("thread/compact/start", {
      threadId: "thread-123",
    });

    expect(result).toEqual({ ok: true });
    expect(bridge.request).toHaveBeenNthCalledWith(1, "thread/compact/start", {
      threadId: "thread-123",
    });
    expect(bridge.request).toHaveBeenNthCalledWith(2, "thread/read", {
      threadId: "thread-123",
      includeTurns: false,
    });
    expect(findProjectByCwd).toHaveBeenCalledWith("/repo");
    expect(buildThreadConfig).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenNthCalledWith(3, "thread/resume", {
      threadId: "thread-123",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      personality: "pragmatic",
      persistExtendedHistory: true,
    });
    expect(bridge.request).toHaveBeenNthCalledWith(4, "thread/compact/start", {
      threadId: "thread-123",
    });
  });

  test("falls back to the thread cwd when no project matches", async () => {
    const bridge = {
      request: vi.fn()
        .mockResolvedValueOnce({ thread: { cwd: "/detached" } })
        .mockResolvedValueOnce({ ok: true }),
    };
    const helpers = createThreadActionHelpers({
      bridge,
      findProjectByCwd: vi.fn().mockResolvedValue(null),
      buildThreadConfig: vi.fn(),
      cleanString,
      compactObject,
    });

    await helpers.resumeThreadForDetachedAction("thread-456");

    expect(bridge.request).toHaveBeenNthCalledWith(1, "thread/read", {
      threadId: "thread-456",
      includeTurns: false,
    });
    expect(bridge.request).toHaveBeenNthCalledWith(2, "thread/resume", {
      threadId: "thread-456",
      cwd: "/detached",
      persistExtendedHistory: true,
    });
  });

  test("does not retry unrelated backend errors", async () => {
    const bridge = {
      request: vi.fn().mockRejectedValue(new Error("permission denied")),
    };
    const helpers = createThreadActionHelpers({
      bridge,
      findProjectByCwd: vi.fn(),
      buildThreadConfig: vi.fn(),
      cleanString,
      compactObject,
    });

    await expect(helpers.requestThreadActionWithResumeRetry("thread/compact/start", {
      threadId: "thread-789",
    })).rejects.toThrow("permission denied");

    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(bridge.request).toHaveBeenCalledWith("thread/compact/start", {
      threadId: "thread-789",
    });
  });
});
