import { describe, expect, test } from "vitest";
import {
  createFramePacket,
  parseControlMessage,
  parseFramePacket,
  serializeControlMessage,
} from "../../packages/protocol/index.mjs";

describe("protocol", () => {
  test("serializes and parses hello control packets", () => {
    const raw = serializeControlMessage({
      type: "hello",
      clientType: "browser",
      supportedEncodings: ["jpeg"],
      canvasWidth: 1,
      canvasHeight: 1,
      devicePixelRatio: 1,
    });

    expect(parseControlMessage(raw)).toMatchObject({
      type: "hello",
      clientType: "browser",
      protocolVersion: 1,
    });
  });

  test("serializes and parses resize control packets", () => {
    const raw = serializeControlMessage({
      type: "resize",
      width: 1280,
      height: 720,
      scale: 1,
    });

    expect(parseControlMessage(raw)).toMatchObject({
      type: "resize",
      width: 1280,
      height: 720,
      protocolVersion: 1,
    });
  });

  test("encodes and decodes frame packets", () => {
    const packet = createFramePacket({
      sequence: 4,
      sessionWidth: 100,
      sessionHeight: 50,
      encoding: "jpeg",
      flags: 0x000d,
      rects: [{
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        payload: new Uint8Array([1, 2, 3]),
      }],
    });

    const parsed = parseFramePacket(packet);
    expect(parsed.sequence).toBe(4);
    expect(parsed.encoding).toBe("jpeg");
    expect(parsed.rects[0].payload).toEqual(new Uint8Array([1, 2, 3]));
  });
});
