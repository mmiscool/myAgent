import { describe, expect, test } from "vitest";
import { buildChatPanePath } from "../../src/pane-bridge.mjs";

describe("pane bridge chat pane paths", () => {
  test("builds a standalone conversation URL with project and thread parameters", () => {
    expect(buildChatPanePath({
      projectId: "project 1",
      threadId: "thread/2",
      tabId: "chat:thread/2",
    })).toBe("/panes/chat.html?projectId=project+1&threadId=thread%2F2&tabId=chat%3Athread%2F2");
  });

  test("omits empty chat pane parameters", () => {
    expect(buildChatPanePath({ projectId: "project-1" })).toBe("/panes/chat.html?projectId=project-1");
  });
});
