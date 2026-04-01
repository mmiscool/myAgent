import jpeg from "jpeg-js";
import { PNG } from "pngjs";

function bgraToRgba(frame) {
  const rgba = new Uint8Array(frame.width * frame.height * 4);
  let sourceIndex = 0;
  let targetIndex = 0;

  for (let row = 0; row < frame.height; row += 1) {
    sourceIndex = row * frame.stride;
    for (let column = 0; column < frame.width; column += 1) {
      rgba[targetIndex] = frame.data[sourceIndex + 2];
      rgba[targetIndex + 1] = frame.data[sourceIndex + 1];
      rgba[targetIndex + 2] = frame.data[sourceIndex];
      rgba[targetIndex + 3] = frame.data[sourceIndex + 3] || 255;
      sourceIndex += 4;
      targetIndex += 4;
    }
  }

  return rgba;
}

export function encodeRawRect(frame) {
  return frame.data instanceof Uint8Array ? frame.data : new Uint8Array(frame.data);
}

export function encodePngFrame(frame, compressionLevel = 6) {
  const png = new PNG({
    width: frame.width,
    height: frame.height,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
  });

  png.data = Buffer.from(bgraToRgba(frame));
  return PNG.sync.write(png, { colorType: 6, compressionLevel });
}

export function encodeJpegFrame(frame, quality = 0.7) {
  const rgba = bgraToRgba(frame);
  const encoded = jpeg.encode(
    {
      width: frame.width,
      height: frame.height,
      data: rgba,
    },
    Math.max(1, Math.min(100, Math.round(quality * 100))),
  );
  return encoded.data;
}

export function encodeFrame(frame, options = {}) {
  const encoding = options.encoding || "jpeg";
  if (encoding === "raw") {
    return encodeRawRect(frame);
  }
  if (encoding === "png") {
    return encodePngFrame(frame, options.pngCompressionLevel ?? 6);
  }
  if (encoding === "jpeg") {
    return encodeJpegFrame(frame, options.jpegQuality ?? 0.7);
  }
  throw new Error("unsupported-encoding");
}
