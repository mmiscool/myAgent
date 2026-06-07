import { describe, expect, test } from "vitest";
import {
  captureHostComposerRenderState,
  mergeIncomingHostComposerState,
} from "../../src/chat-pane-composer.mjs";

describe("chat pane composer host sync", () => {
  test("ignores unrelated thread fields when computing render state", () => {
    const composerState = {
      projectId: "project-1",
      threadId: "thread-1",
      autoscroll: true,
      thread: { id: "thread-1", name: "Before" },
      pendingRequests: [{ id: "one" }],
      composer: {
        draftText: "hello",
        attachments: [{ id: "image-1", name: "image.png", url: "data:image/png;base64,aaa" }],
        sendInFlight: false,
        modelLabel: "GPT",
        effortLabel: "High",
        hasModelOptions: true,
        hasEffortOptions: true,
        modelMenuHtml: "<button>GPT</button>",
        effortMenuHtml: "<button>High</button>",
        mode: "default",
        modeLabel: "Chat",
        useMonaco: true,
        approveAllDangerous: false,
        ralphLoop: false,
        ralphLoopLimit: 3,
      },
    };

    const unrelatedThreadUpdate = {
      ...composerState,
      thread: { id: "thread-1", name: "After", status: "inProgress" },
      pendingRequests: [{ id: "two" }],
    };

    expect(captureHostComposerRenderState(unrelatedThreadUpdate)).toEqual(captureHostComposerRenderState(composerState));
  });

  test("includes editor mode changes in the render state", () => {
    const baseState = {
      projectId: "project-1",
      threadId: "thread-1",
      autoscroll: true,
      composer: {
        draftText: "hello",
        attachments: [],
        sendInFlight: false,
        modelLabel: "GPT",
        effortLabel: "High",
        hasModelOptions: true,
        hasEffortOptions: true,
        modelMenuHtml: "<button>GPT</button>",
        effortMenuHtml: "<button>High</button>",
        mode: "default",
        modeLabel: "Chat",
        useMonaco: true,
        approveAllDangerous: false,
        ralphLoop: false,
        ralphLoopLimit: 3,
      },
    };

    expect(captureHostComposerRenderState({
      ...baseState,
      composer: {
        ...baseState.composer,
        useMonaco: false,
      },
    })).not.toEqual(captureHostComposerRenderState(baseState));
  });

  test("preserves the locally focused draft over stale host state", () => {
    const merged = mergeIncomingHostComposerState({
      draftText: "local draft",
      attachments: [{ id: "existing", name: "existing.png", url: "data:existing" }],
      sendInFlight: false,
    }, {
      draftText: "stale host draft",
      attachments: [{ id: "remote", name: "remote.png", url: "data:remote" }],
      sendInFlight: true,
    }, {
      draftTextOverride: "new local draft",
    });

    expect(merged).toEqual({
      draftText: "new local draft",
      attachments: [{ id: "remote", name: "remote.png", url: "data:remote" }],
      sendInFlight: true,
    });
  });
});
