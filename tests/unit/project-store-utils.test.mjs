import { describe, expect, test } from "vitest";
import projectStoreUtils from "../../project-store-utils.js";

const { dedupeProjectsByPath, projectPathKey } = projectStoreUtils;

describe("project-store-utils", () => {
  test("normalizes path keys with trailing separators", () => {
    expect(projectPathKey("/tmp/example")).toBe(projectPathKey("/tmp/example/"));
  });

  test("dedupes duplicate projects by cwd and preserves the first entry", () => {
    const deduped = dedupeProjectsByPath([
      {
        id: "newer",
        name: "BREP",
        cwd: "/home/user/projects/BREP",
        createdAt: 20,
        updatedAt: 40,
      },
      {
        id: "older",
        name: "BREP duplicate",
        cwd: "/home/user/projects/BREP/",
        createdAt: 10,
        updatedAt: 30,
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("newer");
    expect(deduped[0].name).toBe("BREP");
    expect(deduped[0].createdAt).toBe(10);
    expect(deduped[0].updatedAt).toBe(40);
  });

  test("prefers the workspace project when cwd duplicates the current repo", () => {
    const deduped = dedupeProjectsByPath([
      {
        id: "manual-entry",
        name: "myAgent",
        cwd: "/home/user/projects/myAgent",
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: "workspace",
        name: "Current Workspace",
        cwd: "/home/user/projects/myAgent/",
        createdAt: 10,
        updatedAt: 30,
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("workspace");
    expect(deduped[0].createdAt).toBe(10);
    expect(deduped[0].updatedAt).toBe(30);
  });
});
