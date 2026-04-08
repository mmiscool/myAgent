import { describe, expect, test } from "vitest";
import { parseLocalFileLinkHref } from "../../src/file-link-utils.mjs";

describe("file-link-utils", () => {
  test("parses a plain absolute path link", () => {
    expect(parseLocalFileLinkHref("/home/user/projects/myAgent/src/app.js")).toEqual({
      path: "/home/user/projects/myAgent/src/app.js",
      line: 0,
      column: 0,
    });
  });

  test("parses line and column from colon suffixes", () => {
    expect(parseLocalFileLinkHref("/home/user/projects/myAgent/src/app.js:45:7")).toEqual({
      path: "/home/user/projects/myAgent/src/app.js",
      line: 45,
      column: 7,
    });
  });

  test("parses line and column from hash anchors", () => {
    expect(parseLocalFileLinkHref("/home/user/projects/myAgent/src/app.js#L12C3")).toEqual({
      path: "/home/user/projects/myAgent/src/app.js",
      line: 12,
      column: 3,
    });
  });

  test("ignores non-local links", () => {
    expect(parseLocalFileLinkHref("https://example.com")).toBeNull();
    expect(parseLocalFileLinkHref("#section")).toBeNull();
  });
});
