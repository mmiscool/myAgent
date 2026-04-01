function fnv1a(bytes, offset, length, stride, bytesPerPixel, rowWidth) {
  let hash = 0x811c9dc5;
  for (let row = 0; row < length.height; row += 1) {
    let rowOffset = offset + (row * stride);
    const end = rowOffset + (rowWidth * bytesPerPixel);
    for (; rowOffset < end; rowOffset += 1) {
      hash ^= bytes[rowOffset];
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function rectsAdjacent(a, b) {
  const horizontalMatch = a.y === b.y && a.height === b.height && a.x + a.width === b.x;
  const verticalMatch = a.x === b.x && a.width === b.width && a.y + a.height === b.y;
  return horizontalMatch || verticalMatch;
}

function mergeRects(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

export function tileFrame({ width, height, tileSize }) {
  const tiles = [];
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
      });
    }
  }
  return tiles;
}

export function hashTiles(frame, tileSize = 64) {
  const { width, height, stride, data } = frame;
  const tiles = tileFrame({ width, height, tileSize });
  const bytesPerPixel = Math.max(1, Math.floor(stride / width));

  return tiles.map((tile) => ({
    ...tile,
    hash: fnv1a(
      data,
      (tile.y * stride) + (tile.x * bytesPerPixel),
      tile,
      stride,
      bytesPerPixel,
      tile.width,
    ),
  }));
}

export function detectDirtyTiles(previousHashes, frame, tileSize = 64) {
  const hashes = hashTiles(frame, tileSize);
  const dirtyTiles = [];
  const nextHashes = new Map();

  for (const tile of hashes) {
    const key = `${tile.x}:${tile.y}:${tile.width}:${tile.height}`;
    nextHashes.set(key, tile.hash);
    if (!previousHashes || previousHashes.get(key) !== tile.hash) {
      dirtyTiles.push({
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
      });
    }
  }

  return { dirtyTiles, hashes: nextHashes };
}

export function coalesceDirtyRects(rects) {
  if (!rects.length) {
    return [];
  }

  const sorted = [...rects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const result = [];

  for (const rect of sorted) {
    const last = result[result.length - 1];
    if (last && rectsAdjacent(last, rect)) {
      result[result.length - 1] = mergeRects(last, rect);
    } else {
      result.push({ ...rect });
    }
  }

  return result;
}
