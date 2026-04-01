function createBufferCanvas() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  return { canvas, context };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class CanvasRenderer {
  constructor(options = {}) {
    this.autoScale = options.autoScale !== false;
    this.canvas = null;
    this.context = null;
    this.buffer = createBufferCanvas();
    this.sessionWidth = 0;
    this.sessionHeight = 0;
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.syncCanvasSize();
  }

  detachCanvas() {
    this.canvas = null;
    this.context = null;
  }

  setScreenInfo(width, height) {
    this.sessionWidth = width;
    this.sessionHeight = height;
    this.buffer.canvas.width = width;
    this.buffer.canvas.height = height;
    this.syncCanvasSize();
  }

  syncCanvasSize() {
    if (!this.canvas || !this.sessionWidth || !this.sessionHeight) {
      return;
    }

    this.canvas.width = this.sessionWidth;
    this.canvas.height = this.sessionHeight;

    if (this.autoScale) {
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      this.canvas.style.objectFit = "contain";
    }
  }

  async renderPacket(packet) {
    for (const rect of packet.rects) {
      await this.renderRect(rect, packet.encoding);
    }
    this.flush();
  }

  async renderRect(rect, encoding) {
    if (encoding === "raw") {
      this.renderRawRect(rect);
      return;
    }

    const blobType = encoding === "png" ? "image/png" : "image/jpeg";
    const bitmap = await createImageBitmap(new Blob([rect.payload], { type: blobType }));
    this.buffer.context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
    bitmap.close();
  }

  renderRawRect(rect) {
    const rgba = new Uint8ClampedArray(rect.width * rect.height * 4);
    for (let index = 0, source = 0; index < rgba.length; index += 4, source += 4) {
      rgba[index] = rect.payload[source + 2];
      rgba[index + 1] = rect.payload[source + 1];
      rgba[index + 2] = rect.payload[source];
      rgba[index + 3] = rect.payload[source + 3] || 255;
    }
    const imageData = new ImageData(rgba, rect.width, rect.height);
    this.buffer.context.putImageData(imageData, rect.x, rect.y);
  }

  flush() {
    if (!this.context || !this.canvas) {
      return;
    }

    this.context.imageSmoothingEnabled = false;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.buffer.canvas, 0, 0, this.canvas.width, this.canvas.height);
  }

  mapCanvasPointToRemote(clientX, clientY) {
    if (!this.canvas || !this.sessionWidth || !this.sessionHeight) {
      return { x: 0, y: 0 };
    }

    const rect = this.canvas.getBoundingClientRect();
    const canvasAspect = this.sessionWidth / this.sessionHeight;
    const rectAspect = rect.width / rect.height;

    let drawWidth = rect.width;
    let drawHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (this.autoScale) {
      if (rectAspect > canvasAspect) {
        drawWidth = rect.height * canvasAspect;
        offsetX = (rect.width - drawWidth) / 2;
      } else {
        drawHeight = rect.width / canvasAspect;
        offsetY = (rect.height - drawHeight) / 2;
      }
    }

    const localX = clamp(clientX - rect.left - offsetX, 0, drawWidth);
    const localY = clamp(clientY - rect.top - offsetY, 0, drawHeight);

    return {
      x: Math.round((localX / Math.max(drawWidth, 1)) * (this.sessionWidth - 1)),
      y: Math.round((localY / Math.max(drawHeight, 1)) * (this.sessionHeight - 1)),
    };
  }
}
