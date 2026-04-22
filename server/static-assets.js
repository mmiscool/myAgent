function createStaticAssetHandler({ fs, fsp, path, rootDir, distDir, contentTypes, sendError }) {
  return async function serveStatic(pathname, response) {
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
    const distExists = fs.existsSync(distDir);
    let filePath;

    if (distExists) {
      filePath = path.join(distDir, safePath);

      if (!filePath.startsWith(distDir)) {
        sendError(response, 403, "Forbidden");
        return;
      }
    } else if (safePath === "/index.html") {
      filePath = path.join(rootDir, "index.html");
    } else if (safePath.startsWith("/src/")) {
      filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(path.join(rootDir, "src"))) {
        sendError(response, 403, "Forbidden");
        return;
      }
    } else if (safePath.startsWith("/packages/")) {
      filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(path.join(rootDir, "packages"))) {
        sendError(response, 403, "Forbidden");
        return;
      }
    } else if (safePath.startsWith("/public/")) {
      filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(path.join(rootDir, "public"))) {
        sendError(response, 403, "Forbidden");
        return;
      }
    } else if (safePath.startsWith("/panes/")) {
      filePath = path.join(rootDir, safePath);

      if (!filePath.startsWith(path.join(rootDir, "panes"))) {
        sendError(response, 403, "Forbidden");
        return;
      }
    } else {
      sendError(response, 404, "Not found");
      return;
    }

    try {
      const contents = await fsp.readFile(filePath);
      const contentType = contentTypes[path.extname(filePath)] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType });
      response.end(contents);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendError(response, 404, "Not found");
        return;
      }

      throw error;
    }
  };
}

module.exports = {
  createStaticAssetHandler,
};
