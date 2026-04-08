import { describe, expect, test } from "vitest";
import fileResourceUtils from "../../file-resource-utils.js";

const {
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  isPathInsideRoot,
} = fileResourceUtils;

describe("file-resource-utils", () => {
  test("detects image files by extension", () => {
    expect(isImageFilePath("/repo/assets/screenshot.png")).toBe(true);
    expect(isImageFilePath("/repo/src/app.js")).toBe(false);
  });

  test("checks whether a path stays inside the allowed root", () => {
    expect(isPathInsideRoot("/repo/src/app.js", "/repo")).toBe(true);
    expect(isPathInsideRoot("/repo/../secret.txt", "/repo")).toBe(false);
  });

  test("guesses common mime types", () => {
    expect(guessMimeType("/repo/image.svg")).toBe("image/svg+xml");
    expect(guessMimeType("/repo/file.unknown")).toBe("application/octet-stream");
  });

  test("flags buffers with null bytes as binary", () => {
    expect(isBinaryBuffer(Buffer.from("plain text"))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });
});
