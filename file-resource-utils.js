const fs = require("fs");
const path = require("path");

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const MIME_TYPES = {
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

function normalizePathForComparison(value) {
  let normalized = path.resolve(String(value || "").trim() || ".");

  if (normalized.length > 1) {
    normalized = normalized.replace(/[\\/]+$/g, "");
  }

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInsideRoot(candidatePath, rootPath) {
  const candidate = normalizePathForComparison(candidatePath);
  const root = normalizePathForComparison(rootPath);
  const relative = path.relative(root, candidate);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isImageFilePath(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function guessMimeType(filePath) {
  return MIME_TYPES[path.extname(String(filePath || "")).toLowerCase()] || "application/octet-stream";
}

function isBinaryBuffer(buffer) {
  const sample = Buffer.isBuffer(buffer) ? buffer.subarray(0, 8000) : Buffer.alloc(0);

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
}

async function canWriteFile(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  isPathInsideRoot,
  normalizePathForComparison,
};
