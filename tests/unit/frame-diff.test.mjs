import { describe, expect, test } from "vitest";
import { coalesceDirtyRects, detectDirtyTiles } from "../../packages/frame-diff/index.mjs";

function makeFrame(values) {
  return {
    width: 4,
    height: 4,
    stride: 16,
    data: new Uint8Array(values),
  };
}

describe("frame diff", () => {
  test("detects changed tiles", () => {
    const before = makeFrame(new Array(64).fill(0));
    const afterData = new Array(64).fill(0);
    afterData[0] = 1;
    const after = makeFrame(afterData);

    const initial = detectDirtyTiles(null, before, 2);
    const changed = detectDirtyTiles(initial.hashes, after, 2);

    expect(changed.dirtyTiles).toHaveLength(1);
    expect(changed.dirtyTiles[0]).toMatchObject({ x: 0, y: 0, width: 2, height: 2 });
  });

  test("coalesces adjacent rects", () => {
    const rects = coalesceDirtyRects([
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 2, height: 2 },
    ]);

    expect(rects).toEqual([{ x: 0, y: 0, width: 4, height: 2 }]);
  });
});
