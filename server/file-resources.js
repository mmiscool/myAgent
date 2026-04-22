function createFileResourceHandlers({
  fsp,
  path,
  cleanString,
  listProjects,
  createHttpError,
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  isPathInsideRoot,
}) {
  function buildInlineFileUrl(filePath, version) {
    const url = new URL("/api/file/content", "http://localhost");
    url.searchParams.set("path", filePath);
    if (version) {
      url.searchParams.set("v", String(version));
    }
    return `${url.pathname}${url.search}`;
  }

  async function listAllowedFileRoots() {
    const projects = await listProjects();
    return Array.from(new Set(projects.map((project) => path.resolve(project.cwd))));
  }

  async function resolveAllowedFilePath(requestedPath) {
    const rawPath = cleanString(requestedPath);

    if (!rawPath) {
      throw createHttpError(400, "path is required");
    }

    if (!path.isAbsolute(rawPath)) {
      throw createHttpError(400, "path must be absolute");
    }

    const resolvedPath = path.resolve(rawPath);
    const realPath = await fsp.realpath(resolvedPath).catch((error) => {
      if (error.code === "ENOENT") {
        throw createHttpError(404, "File not found");
      }

      throw error;
    });
    const stats = await fsp.stat(realPath);

    if (!stats.isFile()) {
      throw createHttpError(400, "Path must point to a file");
    }

    const allowedRoots = await listAllowedFileRoots();
    if (!allowedRoots.some((root) => isPathInsideRoot(realPath, root))) {
      throw createHttpError(403, "File is outside the available project roots");
    }

    return { filePath: realPath, stats };
  }

  async function readFileResource(filePath, stats) {
    const fileStats = stats || await fsp.stat(filePath);
    const mimeType = guessMimeType(filePath);
    const writable = await canWriteFile(filePath);
    const viewUrl = buildInlineFileUrl(filePath, Math.round(fileStats.mtimeMs));

    if (isImageFilePath(filePath)) {
      return {
        path: filePath,
        name: path.basename(filePath),
        kind: "image",
        mimeType,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        writable,
        viewUrl,
      };
    }

    const buffer = await fsp.readFile(filePath);
    const text = isBinaryBuffer(buffer) ? null : buffer.toString("utf8");

    return {
      path: filePath,
      name: path.basename(filePath),
      kind: text === null ? "binary" : "text",
      mimeType,
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
      writable,
      text,
      viewUrl,
    };
  }

  return {
    readFileResource,
    resolveAllowedFilePath,
  };
}

module.exports = {
  createFileResourceHandlers,
};
