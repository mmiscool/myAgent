// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import { InputNormalizer } from "../../packages/input-normalizer/index.mjs";

function createNormalizer(options = {}) {
  return new InputNormalizer({
    renderer: {
      mapCanvasPointToRemote(clientX, clientY) {
        return { x: clientX, y: clientY };
      },
    },
    send: vi.fn(),
    batchDelay: 8,
    ...options,
  });
}

describe("input normalizer keyboard capture", () => {
  test("captures navigation keys across the page when enabled", () => {
    const send = vi.fn();
    const documentListener = vi.fn();
    const normalizer = createNormalizer({
      send,
      captureKeyboardOnPage: true,
    });

    document.body.innerHTML = `
      <button id="toolbarButton" type="button">Toolbar</button>
      <canvas id="screen"></canvas>
    `;

    const button = document.getElementById("toolbarButton");
    const canvas = document.getElementById("screen");
    document.addEventListener("keydown", documentListener);
    normalizer.attach(canvas);

    const arrowEvent = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      code: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    const pageEvent = new KeyboardEvent("keydown", {
      key: "PageDown",
      code: "PageDown",
      bubbles: true,
      cancelable: true,
    });

    expect(button.dispatchEvent(arrowEvent)).toBe(false);
    expect(button.dispatchEvent(pageEvent)).toBe(false);
    normalizer.flush();

    expect(documentListener).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([
      { kind: "keyDown", code: "ArrowLeft", key: "ArrowLeft", modifiers: 0 },
      { kind: "keyDown", code: "PageDown", key: "PageDown", modifiers: 0 },
    ]);

    normalizer.detach();
    document.removeEventListener("keydown", documentListener);
    document.body.innerHTML = "";
  });

  test("leaves local text inputs alone when page capture is enabled", () => {
    const send = vi.fn();
    const normalizer = createNormalizer({
      send,
      captureKeyboardOnPage: true,
    });

    document.body.innerHTML = `
      <input id="commandInput" type="text">
      <canvas id="screen"></canvas>
    `;

    const input = document.getElementById("commandInput");
    const canvas = document.getElementById("screen");
    normalizer.attach(canvas);

    const event = new KeyboardEvent("keydown", {
      key: "PageUp",
      code: "PageUp",
      bubbles: true,
      cancelable: true,
    });

    expect(input.dispatchEvent(event)).toBe(true);
    normalizer.flush();

    expect(send).not.toHaveBeenCalled();

    normalizer.detach();
    document.body.innerHTML = "";
  });

  test("still requires canvas focus when page capture is disabled", () => {
    const send = vi.fn();
    const normalizer = createNormalizer({ send });

    document.body.innerHTML = `
      <button id="toolbarButton" type="button">Toolbar</button>
      <canvas id="screen"></canvas>
    `;

    const button = document.getElementById("toolbarButton");
    const canvas = document.getElementById("screen");
    normalizer.attach(canvas);

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      code: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });

    expect(button.dispatchEvent(event)).toBe(true);
    normalizer.flush();

    expect(send).not.toHaveBeenCalled();

    normalizer.detach();
    document.body.innerHTML = "";
  });
});
