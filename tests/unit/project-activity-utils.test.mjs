import { describe, expect, test } from "vitest";
import {
  projectActivityTimestamp,
  sortProjectsByRecentConversationActivity,
  threadActivityTimestamp,
} from "../../src/project-activity-utils.mjs";

describe("project-activity-utils", () => {
  test("uses updatedAt before createdAt for thread activity", () => {
    expect(threadActivityTimestamp({ createdAt: 10, updatedAt: 25 })).toBe(25);
    expect(threadActivityTimestamp({ createdAt: 10 })).toBe(10);
    expect(threadActivityTimestamp({})).toBe(0);
  });

  test("returns the latest thread activity timestamp for a project", () => {
    const projectThreads = {
      alpha: [
        { createdAt: 10, updatedAt: 20 },
        { createdAt: 30 },
      ],
    };

    expect(projectActivityTimestamp("alpha", projectThreads)).toBe(30);
    expect(projectActivityTimestamp("missing", projectThreads)).toBe(0);
  });

  test("sorts projects by latest conversation activity descending", () => {
    const projects = [
      { id: "workspace", cwd: "/home/user/projects/myAgent" },
      { id: "brep", cwd: "/home/user/projects/BREP" },
      { id: "notes", cwd: "/home/user/projects/notes" },
    ];
    const projectThreads = {
      workspace: [{ updatedAt: 50 }],
      brep: [{ updatedAt: 90 }, { updatedAt: 70 }],
      notes: [],
    };

    expect(sortProjectsByRecentConversationActivity(projects, projectThreads).map((project) => project.id)).toEqual([
      "brep",
      "workspace",
      "notes",
    ]);
  });

  test("preserves original order for ties and inactive projects", () => {
    const projects = [
      { id: "first", cwd: "/tmp/first" },
      { id: "second", cwd: "/tmp/second" },
      { id: "third", cwd: "/tmp/third" },
    ];
    const projectThreads = {
      first: [{ updatedAt: 25 }],
      second: [{ updatedAt: 25 }],
      third: [],
    };

    expect(sortProjectsByRecentConversationActivity(projects, projectThreads).map((project) => project.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
