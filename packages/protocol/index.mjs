export const protocolVersion = 1;
export const FRAME_MESSAGE_TYPE = 1;

export const encodingIds = Object.freeze({
  raw: 1,
  png: 2,
  jpeg: 3,
});

export const encodingNames = Object.freeze({
  1: "raw",
  2: "png",
  3: "jpeg",
});

export const frameFlags = Object.freeze({
  FULL_FRAME: 0x0001,
  DIRTY_TILES: 0x0002,
  KEYFRAME: 0x0004,
  END_OF_FRAME: 0x0008,
});

const CONTROL_TYPES = new Set([
  "hello",
  "auth",
  "auth-ok",
  "auth-failed",
  "screen-info",
  "stream-config",
  "ping",
  "pong",
  "error",
  "input",
  "resize",
]);

export function withProtocolVersion(payload) {
  return {
    ...payload,
    protocolVersion,
  };
}

export function isSupportedEncoding(name) {
  return typeof name === "string" && Object.hasOwn(encodingIds, name);
}

export function validateControlMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: "control-message-must-be-object" };
  }

  if (!CONTROL_TYPES.has(message.type)) {
    return { ok: false, error: "unsupported-control-type" };
  }

  if (message.protocolVersion !== protocolVersion) {
    return { ok: false, error: "unsupported-protocol-version" };
  }

  if (message.type === "hello") {
    if (message.clientType && message.clientType !== "browser") {
      return { ok: false, error: "unsupported-client-type" };
    }

    if (message.serverType && message.serverType !== "headless-x11-host") {
      return { ok: false, error: "unsupported-server-type" };
    }
  }

  if (message.type === "auth" && typeof message.token !== "string") {
    return { ok: false, error: "auth-token-required" };
  }

  if (message.type === "input") {
    if (!Array.isArray(message.events)) {
      return { ok: false, error: "input-events-must-be-array" };
    }
  }

  if (message.type === "resize") {
    if (!Number.isInteger(message.width) || !Number.isInteger(message.height)) {
      return { ok: false, error: "resize-width-height-required" };
    }
  }

  if (message.type === "stream-config" && !isSupportedEncoding(message.encoding)) {
    return { ok: false, error: "unsupported-encoding" };
  }

  return { ok: true };
}

export function serializeControlMessage(message) {
  const payload = withProtocolVersion(message);
  const validation = validateControlMessage(payload);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  return JSON.stringify(payload);
}

export function parseControlMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("malformed-json-packet");
  }

  const validation = validateControlMessage(parsed);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  return parsed;
}

export function createFramePacket({
  sequence,
  sessionWidth,
  sessionHeight,
  encoding,
  rects,
  flags,
}) {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error("invalid-sequence");
  }

  if (!isSupportedEncoding(encoding)) {
    throw new Error("unsupported-encoding");
  }

  if (!Array.isArray(rects) || rects.length === 0) {
    throw new Error("frame-must-have-rects");
  }

  const headerSize = 16;
  const rectHeaderSize = 12;
  const totalLength = rects.reduce((size, rect) => size + rectHeaderSize + rect.payload.length, headerSize);
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, FRAME_MESSAGE_TYPE);
  view.setUint8(1, encodingIds[encoding]);
  view.setUint16(2, 0, true);
  view.setUint32(4, sequence, true);
  view.setUint16(8, sessionWidth, true);
  view.setUint16(10, sessionHeight, true);
  view.setUint16(12, rects.length, true);
  view.setUint16(14, flags, true);

  let offset = headerSize;
  for (const rect of rects) {
    view.setUint16(offset, rect.x, true);
    view.setUint16(offset + 2, rect.y, true);
    view.setUint16(offset + 4, rect.width, true);
    view.setUint16(offset + 6, rect.height, true);
    view.setUint32(offset + 8, rect.payload.length, true);
    offset += rectHeaderSize;
    bytes.set(rect.payload, offset);
    offset += rect.payload.length;
  }

  return new Uint8Array(buffer);
}

export function parseFramePacket(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 16) {
    throw new Error("malformed-binary-packet");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messageType = view.getUint8(0);
  if (messageType !== FRAME_MESSAGE_TYPE) {
    throw new Error("malformed-binary-packet");
  }

  const encodingId = view.getUint8(1);
  const encoding = encodingNames[encodingId];
  if (!encoding) {
    throw new Error("unsupported-encoding");
  }

  const packet = {
    messageType,
    encoding,
    sequence: view.getUint32(4, true),
    sessionWidth: view.getUint16(8, true),
    sessionHeight: view.getUint16(10, true),
    rectCount: view.getUint16(12, true),
    flags: view.getUint16(14, true),
    rects: [],
  };

  let offset = 16;
  for (let index = 0; index < packet.rectCount; index += 1) {
    if (offset + 12 > bytes.byteLength) {
      throw new Error("malformed-binary-packet");
    }

    const x = view.getUint16(offset, true);
    const y = view.getUint16(offset + 2, true);
    const width = view.getUint16(offset + 4, true);
    const height = view.getUint16(offset + 6, true);
    const payloadLength = view.getUint32(offset + 8, true);
    offset += 12;

    if (offset + payloadLength > bytes.byteLength) {
      throw new Error("malformed-binary-packet");
    }

    packet.rects.push({
      x,
      y,
      width,
      height,
      payload: bytes.slice(offset, offset + payloadLength),
    });
    offset += payloadLength;
  }

  if (offset !== bytes.byteLength) {
    throw new Error("malformed-binary-packet");
  }

  return packet;
}
