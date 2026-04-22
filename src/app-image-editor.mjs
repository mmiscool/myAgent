import { createAttachmentId } from "./attachment-utils.mjs";

export function createImageEditorState() {
  return {
    open: false,
    attachmentId: "",
    image: null,
    imageUrl: "",
    naturalWidth: 0,
    naturalHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    scale: 1,
    tool: "select",
    color: "#d100ff",
    shapes: [],
    cropRect: null,
    selectedShapeId: "",
    drag: null,
  };
}

export function createAppImageEditor({ state, elements, actions }) {
  async function openImageEditor(attachmentId) {
    const attachment = state.composerAttachments.find((item) => item.id === attachmentId);

    if (!attachment) {
      return;
    }

    const image = await loadImage(attachment.url);
    state.imageEditor = {
      ...createImageEditorState(),
      open: true,
      attachmentId,
      image,
      imageUrl: attachment.url,
      naturalWidth: image.naturalWidth || image.width,
      naturalHeight: image.naturalHeight || image.height,
      color: elements.imageEditorColor.value || "#d100ff",
    };
    elements.imageEditorModal.classList.remove("hidden");
    elements.imageEditorModal.setAttribute("aria-hidden", "false");
    actions.syncModalOpenState?.();
    elements.imageEditorPreviewImage.src = attachment.url;
    layoutImageEditorCanvas();
    syncImageEditorToolbar();
    renderImageEditor();
  }

  function closeImageEditor() {
    state.imageEditor = createImageEditorState();
    elements.imageEditorModal.classList.add("hidden");
    elements.imageEditorModal.setAttribute("aria-hidden", "true");
    elements.imageEditorPreviewImage.removeAttribute("src");
    actions.syncModalOpenState?.();
  }

  function setImageEditorTool(tool) {
    if (!state.imageEditor.open) {
      return;
    }

    state.imageEditor.tool = tool || "select";
    if (state.imageEditor.tool !== "select") {
      state.imageEditor.selectedShapeId = "";
    }
    syncImageEditorToolbar();
    renderImageEditor();
  }

  function updateImageEditorColor(color) {
    state.imageEditor.color = color;
    if (state.imageEditor.selectedShapeId) {
      const shape = findSelectedEditorShape();
      if (shape) {
        shape.color = state.imageEditor.color;
        renderImageEditor();
      }
    }
  }

  function syncImageEditorToolbar() {
    document.querySelectorAll("[data-action='editor-tool']").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === state.imageEditor.tool);
    });
    elements.imageEditorColor.value = state.imageEditor.color || "#d100ff";
    elements.imageEditorOverlayCanvas.classList.toggle("select-mode", state.imageEditor.tool === "select");
  }

  function layoutImageEditorCanvas() {
    const editor = state.imageEditor;

    if (!editor.open || !editor.naturalWidth || !editor.naturalHeight) {
      return;
    }

    const maxWidth = Math.max(320, window.innerWidth - 160);
    const maxHeight = Math.max(240, window.innerHeight - 220);
    const scale = Math.min(maxWidth / editor.naturalWidth, maxHeight / editor.naturalHeight, 1);
    editor.scale = scale;
    editor.displayWidth = Math.max(1, Math.round(editor.naturalWidth * scale));
    editor.displayHeight = Math.max(1, Math.round(editor.naturalHeight * scale));

    resizeCanvas(elements.imageEditorOverlayCanvas, editor.displayWidth, editor.displayHeight);
    elements.imageEditorCanvasWrap.style.width = `${editor.displayWidth}px`;
    elements.imageEditorCanvasWrap.style.height = `${editor.displayHeight}px`;
    elements.imageEditorPreviewImage.style.width = `${editor.displayWidth}px`;
    elements.imageEditorPreviewImage.style.height = `${editor.displayHeight}px`;
  }

  function resizeCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderImageEditor() {
    const editor = state.imageEditor;

    if (!editor.open || !editor.image) {
      return;
    }

    const overlay = elements.imageEditorOverlayCanvas.getContext("2d");
    overlay.clearRect(0, 0, editor.displayWidth, editor.displayHeight);

    if (editor.cropRect && !shapeSizeTooSmall(editor.cropRect)) {
      overlay.save();
      clipToRect(overlay, editor.cropRect, editor.scale);
      for (const shape of editor.shapes) {
        drawEditorShape(overlay, shape, editor.scale, shape.id === editor.selectedShapeId);
      }
      overlay.restore();
      drawCropOverlay(overlay, editor.cropRect, editor.scale, editor.selectedShapeId === "__crop__");
      return;
    }

    for (const shape of editor.shapes) {
      drawEditorShape(overlay, shape, editor.scale, shape.id === editor.selectedShapeId);
    }
  }

  function clipToRect(context, rect, scale) {
    context.beginPath();
    context.rect(rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale);
    context.clip();
  }

  function drawCropOverlay(context, rect, scale, selected) {
    const x = rect.x * scale;
    const y = rect.y * scale;
    const w = rect.w * scale;
    const h = rect.h * scale;

    context.save();
    context.fillStyle = "rgba(0, 0, 0, 0.38)";
    context.fillRect(0, 0, state.imageEditor.displayWidth, state.imageEditor.displayHeight);
    context.clearRect(x, y, w, h);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.setLineDash([8, 6]);
    context.strokeRect(x, y, w, h);
    context.setLineDash([]);
    if (selected) {
      drawRectHandles(context, rect, scale);
    }
    context.restore();
  }

  function drawEditorShape(context, shape, scale, selected) {
    context.save();
    context.strokeStyle = shape.color;
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.lineCap = "round";

    if (shape.type === "rect") {
      context.strokeRect(shape.x * scale, shape.y * scale, shape.w * scale, shape.h * scale);
      if (selected) {
        drawRectHandles(context, shape, scale);
      }
    } else {
      const x1 = shape.x1 * scale;
      const y1 = shape.y1 * scale;
      const x2 = shape.x2 * scale;
      const y2 = shape.y2 * scale;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
      if (shape.type === "arrow") {
        drawArrowHead(context, x1, y1, x2, y2, shape.color);
      }
      if (selected) {
        drawPointHandle(context, x1, y1);
        drawPointHandle(context, x2, y2);
      }
    }

    context.restore();
  }

  function drawArrowHead(context, x1, y1, x2, y2, color) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLength = 16;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x2, y2);
    context.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
    context.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  function drawRectHandles(context, shape, scale) {
    for (const point of rectCornerPoints(shape)) {
      drawPointHandle(context, point.x * scale, point.y * scale);
    }
  }

  function drawPointHandle(context, x, y) {
    context.save();
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#0d0e10";
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }

  function handleImageEditorPointerDown(event) {
    const editor = state.imageEditor;

    if (!editor.open) {
      return;
    }

    const point = getEditorPoint(event);

    if (editor.tool === "crop") {
      startCropRect(point);
      return;
    }

    if (editor.tool === "rect" || editor.tool === "line" || editor.tool === "arrow") {
      startEditorShape(point);
      return;
    }

    const hit = hitTestEditorTargets(point);
    editor.selectedShapeId = hit?.shape?.id || "";
    syncImageEditorToolbar();

    if (!hit) {
      renderImageEditor();
      return;
    }

    editor.drag = {
      mode: hit.mode,
      shapeId: hit.shape.id,
      handle: hit.handle || "",
      startPoint: point,
      startShape: cloneShape(hit.shape),
    };
    renderImageEditor();
  }

  function handleImageEditorPointerMove(event) {
    const editor = state.imageEditor;

    if (!editor.open || !editor.drag) {
      return;
    }

    const point = getEditorPoint(event);
    const shape = editor.shapes.find((item) => item.id === editor.drag.shapeId)
      || (editor.drag.shapeId === "__crop__" ? editor.cropRect : null);

    if (!shape) {
      return;
    }

    if (editor.drag.mode === "draw") {
      updateDraftShape(shape, editor.drag.startPoint, point);
    } else if (shape.type === "rect") {
      updateDraggedRect(shape, editor.drag, point);
    } else {
      updateDraggedLine(shape, editor.drag, point);
    }

    normalizeShape(shape);
    renderImageEditor();
  }

  function handleImageEditorPointerUp() {
    const editor = state.imageEditor;

    if (!editor.open || !editor.drag) {
      return;
    }

    const shape = editor.shapes.find((item) => item.id === editor.drag.shapeId)
      || (editor.drag.shapeId === "__crop__" ? editor.cropRect : null);

    if (editor.drag.mode === "draw" && shape && shapeSizeTooSmall(shape)) {
      if (shape.id === "__crop__") {
        editor.cropRect = null;
      }
    }

    if (editor.drag.mode === "draw" && shape && shape.id !== "__crop__" && shapeSizeTooSmall(shape)) {
      editor.shapes = editor.shapes.filter((item) => item.id !== shape.id);
      editor.selectedShapeId = "";
    } else if (shape) {
      editor.selectedShapeId = shape.id;
    }

    editor.drag = null;
    syncImageEditorToolbar();
    renderImageEditor();
  }

  function handleImageEditorDoubleClick() {
    if (!state.imageEditor.open) {
      return;
    }

    state.imageEditor.tool = "select";
    syncImageEditorToolbar();
    renderImageEditor();
  }

  function startEditorShape(point) {
    const editor = state.imageEditor;
    const id = createAttachmentId();
    const shape = editor.tool === "rect"
      ? { id, type: "rect", color: editor.color, x: point.x, y: point.y, w: 0, h: 0 }
      : { id, type: editor.tool, color: editor.color, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    editor.shapes.push(shape);
    editor.selectedShapeId = id;
    editor.drag = {
      mode: "draw",
      shapeId: id,
      startPoint: point,
    };
    renderImageEditor();
  }

  function startCropRect(point) {
    const editor = state.imageEditor;
    editor.cropRect = { id: "__crop__", type: "rect", color: "#ffffff", x: point.x, y: point.y, w: 0, h: 0 };
    editor.selectedShapeId = "__crop__";
    editor.drag = {
      mode: "draw",
      shapeId: "__crop__",
      startPoint: point,
    };
    renderImageEditor();
  }

  function updateDraftShape(shape, start, point) {
    if (shape.type === "rect") {
      shape.x = Math.min(start.x, point.x);
      shape.y = Math.min(start.y, point.y);
      shape.w = Math.abs(point.x - start.x);
      shape.h = Math.abs(point.y - start.y);
      return;
    }

    shape.x2 = point.x;
    shape.y2 = point.y;
  }

  function hitTestEditorTargets(point) {
    if (state.imageEditor.cropRect) {
      const cropHit = hitTestRect(state.imageEditor.cropRect, point);
      if (cropHit) {
        return { ...cropHit, shape: state.imageEditor.cropRect };
      }
    }

    for (let index = state.imageEditor.shapes.length - 1; index >= 0; index -= 1) {
      const shape = state.imageEditor.shapes[index];
      const hit = shape.type === "rect" ? hitTestRect(shape, point) : hitTestLine(shape, point);
      if (hit) {
        return { ...hit, shape };
      }
    }

    return null;
  }

  function hitTestRect(shape, point) {
    const threshold = 10 / state.imageEditor.scale;
    const corners = rectCornerPoints(shape);
    const labels = ["nw", "ne", "se", "sw"];

    for (let index = 0; index < corners.length; index += 1) {
      if (distance(point, corners[index]) <= threshold) {
        return { mode: "resize", handle: labels[index] };
      }
    }

    if (point.x >= shape.x && point.x <= shape.x + shape.w && point.y >= shape.y && point.y <= shape.y + shape.h) {
      return { mode: "move" };
    }

    return null;
  }

  function hitTestLine(shape, point) {
    const threshold = 10 / state.imageEditor.scale;
    const start = { x: shape.x1, y: shape.y1 };
    const end = { x: shape.x2, y: shape.y2 };

    if (distance(point, start) <= threshold) {
      return { mode: "endpoint", handle: "start" };
    }

    if (distance(point, end) <= threshold) {
      return { mode: "endpoint", handle: "end" };
    }

    if (distanceToSegment(point, start, end) <= threshold) {
      return { mode: "move" };
    }

    return null;
  }

  function updateDraggedRect(shape, drag, point) {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;

    if (drag.mode === "move") {
      shape.x = drag.startShape.x + dx;
      shape.y = drag.startShape.y + dy;
      return;
    }

    if (drag.handle === "nw") {
      shape.x = drag.startShape.x + dx;
      shape.y = drag.startShape.y + dy;
      shape.w = drag.startShape.w - dx;
      shape.h = drag.startShape.h - dy;
    } else if (drag.handle === "ne") {
      shape.y = drag.startShape.y + dy;
      shape.w = drag.startShape.w + dx;
      shape.h = drag.startShape.h - dy;
    } else if (drag.handle === "se") {
      shape.w = drag.startShape.w + dx;
      shape.h = drag.startShape.h + dy;
    } else if (drag.handle === "sw") {
      shape.x = drag.startShape.x + dx;
      shape.w = drag.startShape.w - dx;
      shape.h = drag.startShape.h + dy;
    }
  }

  function updateDraggedLine(shape, drag, point) {
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;

    if (drag.mode === "move") {
      shape.x1 = drag.startShape.x1 + dx;
      shape.y1 = drag.startShape.y1 + dy;
      shape.x2 = drag.startShape.x2 + dx;
      shape.y2 = drag.startShape.y2 + dy;
      return;
    }

    if (drag.handle === "start") {
      shape.x1 = point.x;
      shape.y1 = point.y;
    } else if (drag.handle === "end") {
      shape.x2 = point.x;
      shape.y2 = point.y;
    }
  }

  function normalizeShape(shape) {
    const editor = state.imageEditor;

    if (shape.type === "rect") {
      if (shape.w < 0) {
        shape.x += shape.w;
        shape.w = Math.abs(shape.w);
      }
      if (shape.h < 0) {
        shape.y += shape.h;
        shape.h = Math.abs(shape.h);
      }
      shape.x = clamp(shape.x, 0, editor.naturalWidth);
      shape.y = clamp(shape.y, 0, editor.naturalHeight);
      shape.w = clamp(shape.w, 0, editor.naturalWidth - shape.x);
      shape.h = clamp(shape.h, 0, editor.naturalHeight - shape.y);
      return;
    }

    shape.x1 = clamp(shape.x1, 0, editor.naturalWidth);
    shape.y1 = clamp(shape.y1, 0, editor.naturalHeight);
    shape.x2 = clamp(shape.x2, 0, editor.naturalWidth);
    shape.y2 = clamp(shape.y2, 0, editor.naturalHeight);
  }

  function shapeSizeTooSmall(shape) {
    if (shape.type === "rect") {
      return shape.w < 6 || shape.h < 6;
    }

    return distance({ x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) < 6;
  }

  function rectCornerPoints(shape) {
    return [
      { x: shape.x, y: shape.y },
      { x: shape.x + shape.w, y: shape.y },
      { x: shape.x + shape.w, y: shape.y + shape.h },
      { x: shape.x, y: shape.y + shape.h },
    ];
  }

  function getEditorPoint(event) {
    const rect = elements.imageEditorOverlayCanvas.getBoundingClientRect();
    const scale = state.imageEditor.scale || 1;
    return {
      x: clamp((event.clientX - rect.left) / scale, 0, state.imageEditor.naturalWidth),
      y: clamp((event.clientY - rect.top) / scale, 0, state.imageEditor.naturalHeight),
    };
  }

  async function applyImageEditor() {
    const editor = state.imageEditor;
    const attachment = state.composerAttachments.find((item) => item.id === editor.attachmentId);

    if (!editor.open || !attachment || !editor.image) {
      closeImageEditor();
      return;
    }

    const crop = normalizedCropRect(editor);
    const canvas = document.createElement("canvas");
    canvas.width = crop.w;
    canvas.height = crop.h;
    const context = canvas.getContext("2d");
    context.drawImage(editor.image, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    context.save();
    clipToRect(context, { x: 0, y: 0, w: crop.w, h: crop.h }, 1);
    for (const shape of editor.shapes) {
      drawEditorShape(context, offsetShapeForCrop(shape, crop), 1, false);
    }
    context.restore();
    attachment.url = canvas.toDataURL("image/png");
    actions.renderComposerAttachments?.();
    closeImageEditor();
  }

  function normalizedCropRect(editor) {
    if (!editor.cropRect || shapeSizeTooSmall(editor.cropRect)) {
      return {
        x: 0,
        y: 0,
        w: editor.naturalWidth,
        h: editor.naturalHeight,
      };
    }

    return {
      x: Math.round(editor.cropRect.x),
      y: Math.round(editor.cropRect.y),
      w: Math.max(1, Math.round(editor.cropRect.w)),
      h: Math.max(1, Math.round(editor.cropRect.h)),
    };
  }

  function offsetShapeForCrop(shape, crop) {
    const next = cloneShape(shape);

    if (next.type === "rect") {
      next.x -= crop.x;
      next.y -= crop.y;
      return next;
    }

    next.x1 -= crop.x;
    next.y1 -= crop.y;
    next.x2 -= crop.x;
    next.y2 -= crop.y;
    return next;
  }

  function findSelectedEditorShape() {
    if (state.imageEditor.selectedShapeId === "__crop__") {
      return state.imageEditor.cropRect;
    }

    return state.imageEditor.shapes.find((shape) => shape.id === state.imageEditor.selectedShapeId) || null;
  }

  return {
    applyImageEditor,
    closeImageEditor,
    handleImageEditorDoubleClick,
    handleImageEditorPointerDown,
    handleImageEditorPointerMove,
    handleImageEditorPointerUp,
    layoutImageEditorCanvas,
    openImageEditor,
    renderImageEditor,
    setImageEditorTool,
    updateImageEditorColor,
  };
}

function cloneShape(shape) {
  return JSON.parse(JSON.stringify(shape));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point, start, end) {
  const lengthSquared = ((end.x - start.x) ** 2) + ((end.y - start.y) ** 2);

  if (lengthSquared === 0) {
    return distance(point, start);
  }

  let t = (((point.x - start.x) * (end.x - start.x)) + ((point.y - start.y) * (end.y - start.y))) / lengthSquared;
  t = clamp(t, 0, 1);
  return distance(point, {
    x: start.x + (t * (end.x - start.x)),
    y: start.y + (t * (end.y - start.y)),
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = src;
  });
}
