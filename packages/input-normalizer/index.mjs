const MOD_SHIFT = 1 << 0;
const MOD_CONTROL = 1 << 1;
const MOD_ALT = 1 << 2;
const MOD_META = 1 << 3;
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
]);

function buttonMask(buttons) {
  return buttons || 0;
}

function buttonIndex(button) {
  if (button === 1) {
    return 1;
  }
  if (button === 2) {
    return 2;
  }
  return 0;
}

function modifierMask(event) {
  let modifiers = 0;
  if (event.shiftKey) modifiers |= MOD_SHIFT;
  if (event.ctrlKey) modifiers |= MOD_CONTROL;
  if (event.altKey) modifiers |= MOD_ALT;
  if (event.metaKey) modifiers |= MOD_META;
  return modifiers;
}

export function normalizeCanvasCoordinates(renderer, event) {
  return renderer.mapCanvasPointToRemote(event.clientX, event.clientY);
}

function isTextEditableTarget(target) {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  const editable = target.closest("textarea, input, [contenteditable], [contenteditable='plaintext-only']");
  if (!editable) {
    return false;
  }

  const tagName = editable.tagName.toLowerCase();
  if (tagName === "textarea") {
    return true;
  }

  if (tagName === "input") {
    const type = (editable.getAttribute("type") || "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  return editable.getAttribute("contenteditable") !== "false";
}

export class InputNormalizer {
  constructor(options = {}) {
    this.renderer = options.renderer;
    this.send = options.send;
    this.batchDelay = options.batchDelay ?? 8;
    this.enableInput = options.enableInput !== false;
    this.captureKeyboardOnPage = options.captureKeyboardOnPage === true;
    this.canvas = null;
    this.pendingEvents = [];
    this.flushTimer = null;
    this.boundHandlers = null;
  }

  attach(canvas) {
    if (!this.enableInput) {
      return;
    }

    this.detach();
    this.canvas = canvas;
    canvas.tabIndex = 0;

    this.boundHandlers = {
      pointermove: (event) => this.onPointerMove(event),
      pointerdown: (event) => this.onPointerDown(event),
      pointerup: (event) => this.onPointerUp(event),
      wheel: (event) => this.onWheel(event),
      contextmenu: (event) => this.onContextMenu(event),
      keydown: (event) => this.onKey(event, true),
      keyup: (event) => this.onKey(event, false),
    };

    canvas.addEventListener("pointermove", this.boundHandlers.pointermove);
    canvas.addEventListener("pointerdown", this.boundHandlers.pointerdown);
    window.addEventListener("pointerup", this.boundHandlers.pointerup);
    canvas.addEventListener("wheel", this.boundHandlers.wheel, { passive: false });
    canvas.addEventListener("contextmenu", this.boundHandlers.contextmenu);
    window.addEventListener("keydown", this.boundHandlers.keydown, true);
    window.addEventListener("keyup", this.boundHandlers.keyup, true);
  }

  detach() {
    if (!this.canvas || !this.boundHandlers) {
      return;
    }

    this.canvas.removeEventListener("pointermove", this.boundHandlers.pointermove);
    this.canvas.removeEventListener("pointerdown", this.boundHandlers.pointerdown);
    window.removeEventListener("pointerup", this.boundHandlers.pointerup);
    this.canvas.removeEventListener("wheel", this.boundHandlers.wheel);
    this.canvas.removeEventListener("contextmenu", this.boundHandlers.contextmenu);
    window.removeEventListener("keydown", this.boundHandlers.keydown, true);
    window.removeEventListener("keyup", this.boundHandlers.keyup, true);

    this.canvas = null;
    this.boundHandlers = null;
  }

  queue(event) {
    this.pendingEvents.push(event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.batchDelay);
    }
  }

  flush() {
    if (!this.pendingEvents.length) {
      this.flushTimer = null;
      return;
    }

    const events = this.pendingEvents.splice(0, this.pendingEvents.length);
    this.flushTimer = null;
    this.send(events);
  }

  onPointerMove(event) {
    const point = normalizeCanvasCoordinates(this.renderer, event);
    this.queue({
      kind: "pointerMove",
      x: point.x,
      y: point.y,
      buttons: buttonMask(event.buttons),
      modifiers: modifierMask(event),
    });
  }

  onPointerDown(event) {
    event.preventDefault();
    this.canvas?.focus();
    const point = normalizeCanvasCoordinates(this.renderer, event);
    this.queue({
      kind: "pointerDown",
      button: buttonIndex(event.button),
      x: point.x,
      y: point.y,
      buttons: buttonMask(event.buttons),
      modifiers: modifierMask(event),
    });
  }

  onPointerUp(event) {
    const point = this.canvas ? normalizeCanvasCoordinates(this.renderer, event) : { x: 0, y: 0 };
    this.queue({
      kind: "pointerUp",
      button: buttonIndex(event.button),
      x: point.x,
      y: point.y,
      buttons: buttonMask(event.buttons),
      modifiers: modifierMask(event),
    });
  }

  onWheel(event) {
    event.preventDefault();
    const point = normalizeCanvasCoordinates(this.renderer, event);
    this.queue({
      kind: "wheel",
      deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY),
      x: point.x,
      y: point.y,
      modifiers: modifierMask(event),
    });
  }

  onContextMenu(event) {
    event.preventDefault();
  }

  shouldCaptureKey(event) {
    if (!this.canvas?.isConnected) {
      return false;
    }

    if (this.captureKeyboardOnPage) {
      return !isTextEditableTarget(event.target);
    }

    return document.activeElement === this.canvas;
  }

  onKey(event, isDown) {
    if (this.shouldCaptureKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      return;
    }

    this.queue({
      kind: isDown ? "keyDown" : "keyUp",
      code: event.code,
      key: event.key,
      modifiers: modifierMask(event),
    });
  }
}
