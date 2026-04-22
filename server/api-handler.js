function createApiHandler({
  PORT,
  CODEX_BIN,
  ROOT_DIR,
  THREAD_SOURCE_KINDS,
  getModels,
  bridge,
  terminalManager,
  threadActionHelpers,
  parseJsonBody,
  sendJson,
  sendError,
  createHttpError,
  cleanString,
  listProjects,
  saveProject,
  removeProject,
  requireProject,
  buildSandboxPolicy,
  buildThreadConfig,
  buildTurnConfig,
  buildTurnInput,
  resolveComposerSelection,
  resolveAllowedFilePath,
  readFileResource,
  ensureProjectTerminalSession,
  canWriteFile,
  guessMimeType,
  isBinaryBuffer,
  isImageFilePath,
  fsp,
  path,
}) {
  async function getBootState({ includeModels = true } = {}) {
    const [projects, models] = await Promise.all([
      listProjects(),
      includeModels ? getModels() : Promise.resolve({ ok: true, data: [] }),
    ]);

    return {
      ok: true,
      projects,
      models,
      pendingRequests: bridge.listPendingServerRequests(),
      app: {
        port: PORT,
        codexBin: CODEX_BIN,
        rootDir: ROOT_DIR,
      },
    };
  }

  async function getAccountState() {
    try {
      const [accountRead, authStatus] = await Promise.all([
        bridge.request("account/read", { refreshToken: false }),
        bridge.request("getAuthStatus", { includeToken: false, refreshToken: false }),
      ]);

      return {
        ok: true,
        account: accountRead.account,
        requiresOpenaiAuth: accountRead.requiresOpenaiAuth,
        authStatus,
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
      };
    }
  }

  function parseReviewTarget(body) {
    if (body.targetType === "baseBranch") {
      return { type: "baseBranch", branch: cleanString(body.branch) || "main" };
    }

    if (body.targetType === "commit") {
      return { type: "commit", sha: cleanString(body.sha), title: cleanString(body.title) || null };
    }

    if (body.targetType === "custom") {
      return { type: "custom", instructions: cleanString(body.instructions) };
    }

    return { type: "uncommittedChanges" };
  }

  return async function handleApi(request, response, url) {
    const { pathname, searchParams } = url;
    const parts = pathname.split("/").filter(Boolean);

    if (request.method === "GET" && pathname === "/api/boot") {
      sendJson(response, 200, await getBootState({
        includeModels: searchParams.get("includeModels") !== "false",
      }));
      return;
    }

    if (request.method === "GET" && pathname === "/api/models") {
      sendJson(response, 200, await getModels());
      return;
    }

    if (request.method === "GET" && pathname === "/api/account") {
      sendJson(response, 200, await getAccountState());
      return;
    }

    if (request.method === "GET" && pathname === "/api/pending-requests") {
      sendJson(response, 200, { ok: true, data: bridge.listPendingServerRequests() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseJsonBody(request);
      const loginType = body.type === "apiKey" ? "apiKey" : "chatgpt";
      const params = loginType === "apiKey"
        ? { type: "apiKey", apiKey: cleanString(body.apiKey) }
        : { type: "chatgpt" };

      sendJson(response, 200, { ok: true, data: await bridge.request("account/login/start", params) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/auth/logout") {
      sendJson(response, 200, { ok: true, data: await bridge.request("account/logout") });
      return;
    }

    if (request.method === "POST" && pathname === "/api/rpc") {
      const body = await parseJsonBody(request);

      if (!cleanString(body.method) || body.method === "initialize") {
        throw new Error("method is required");
      }

      sendJson(response, 200, {
        ok: true,
        data: await bridge.request(body.method, body.params),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/command") {
      const body = await parseJsonBody(request);
      const project = await requireProject(cleanString(body.projectId));
      const command = cleanString(body.command);

      if (!command) {
        throw new Error("command is required");
      }

      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("command/exec", {
          command: ["bash", "-lc", command],
          cwd: project.cwd,
          timeoutMs: Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : 120000,
          sandboxPolicy: buildSandboxPolicy(project, body),
        }),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/file") {
      const { filePath, stats } = await resolveAllowedFilePath(searchParams.get("path"));
      sendJson(response, 200, { ok: true, data: await readFileResource(filePath, stats) });
      return;
    }

    if (request.method === "PUT" && pathname === "/api/file") {
      const body = await parseJsonBody(request);
      const { filePath, stats } = await resolveAllowedFilePath(body.path);
      const expectedMtimeMs = Number(body.expectedMtimeMs);

      if (isImageFilePath(filePath)) {
        throw createHttpError(400, "Image files are preview-only in this pane");
      }

      const currentBuffer = await fsp.readFile(filePath);
      if (isBinaryBuffer(currentBuffer)) {
        throw createHttpError(400, "Binary files cannot be edited in the text editor");
      }

      if (Number.isFinite(expectedMtimeMs) && Math.round(stats.mtimeMs) !== Math.round(expectedMtimeMs)) {
        throw createHttpError(409, "File changed on disk. Reload it before saving.");
      }

      if (!(await canWriteFile(filePath))) {
        throw createHttpError(403, "File is not writable");
      }

      await fsp.writeFile(filePath, typeof body.text === "string" ? body.text : "", "utf8");
      const nextStats = await fsp.stat(filePath);
      sendJson(response, 200, {
        ok: true,
        data: {
          path: filePath,
          mtimeMs: nextStats.mtimeMs,
          size: nextStats.size,
        },
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/file/content") {
      const { filePath } = await resolveAllowedFilePath(searchParams.get("path"));
      const contents = await fsp.readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename="${path.basename(filePath).replaceAll('"', "")}"`,
        "Content-Type": guessMimeType(filePath),
      });
      response.end(contents);
      return;
    }

    if (request.method === "GET" && parts[1] === "projects" && parts.length === 2) {
      sendJson(response, 200, { ok: true, data: await listProjects() });
      return;
    }

    if (request.method === "POST" && parts[1] === "projects" && parts.length === 2) {
      const body = await parseJsonBody(request);
      sendJson(response, 200, { ok: true, data: await saveProject(body) });
      return;
    }

    if (request.method === "DELETE" && parts[1] === "projects" && parts.length === 3) {
      await terminalManager.closeProjectSession(decodeURIComponent(parts[2])).catch(() => {});
      await removeProject(decodeURIComponent(parts[2]));
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && parts[1] === "projects" && parts[3] === "threads") {
      const project = await requireProject(decodeURIComponent(parts[2]));
      const archived = searchParams.get("archived") === "true";

      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/list", {
          archived,
          cwd: project.cwd,
          limit: 100,
          sortKey: "updated_at",
          sourceKinds: THREAD_SOURCE_KINDS,
        }),
      });
      return;
    }

    if (request.method === "GET" && parts[1] === "projects" && parts[3] === "skills") {
      const project = await requireProject(decodeURIComponent(parts[2]));
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("skills/list", {
          cwds: [project.cwd],
          forceReload: searchParams.get("reload") === "true",
        }),
      });
      return;
    }

    if (request.method === "GET" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
      sendJson(response, 200, {
        ok: true,
        data: terminalManager.getProjectSession(decodeURIComponent(parts[2])),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
      const body = await parseJsonBody(request);
      const session = await ensureProjectTerminalSession(decodeURIComponent(parts[2]), body);
      sendJson(response, 200, { ok: true, data: session });
      return;
    }

    if (request.method === "DELETE" && parts[1] === "projects" && parts[3] === "terminal" && parts.length === 4) {
      const projectId = decodeURIComponent(parts[2]);
      await terminalManager.closeProjectSession(projectId);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && pathname === "/api/threads") {
      const body = await parseJsonBody(request);
      const project = await requireProject(cleanString(body.projectId));
      const selection = await resolveComposerSelection(project, body);
      const threadConfig = buildThreadConfig(project, body, selection);

      const threadResult = await bridge.request("thread/start", {
        ...threadConfig,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        serviceName: "custom-codex-web",
      });

      if (cleanString(body.name)) {
        await bridge.request("thread/name/set", {
          threadId: threadResult.thread.id,
          name: cleanString(body.name),
        });
      }

      if (cleanString(body.prompt) || (Array.isArray(body.images) && body.images.length > 0)) {
        await bridge.request("turn/start", {
          threadId: threadResult.thread.id,
          input: buildTurnInput(body, "prompt"),
          ...buildTurnConfig(project, body, selection),
        });
      }

      sendJson(response, 200, { ok: true, data: threadResult });
      return;
    }

    if (request.method === "GET" && parts[1] === "threads" && parts.length === 3) {
      const threadId = decodeURIComponent(parts[2]);

      try {
        sendJson(response, 200, {
          ok: true,
          data: await bridge.request("thread/read", {
            threadId,
            includeTurns: true,
          }),
        });
      } catch {
        sendJson(response, 200, {
          ok: true,
          data: await bridge.request("thread/read", {
            threadId,
            includeTurns: false,
          }),
        });
      }

      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "message") {
      const body = await parseJsonBody(request);
      const threadId = decodeURIComponent(parts[2]);
      const project = await requireProject(cleanString(body.projectId));
      const selection = await resolveComposerSelection(project, body);
      await bridge.request("thread/resume", {
        threadId,
        ...buildThreadConfig(project, body, selection),
        persistExtendedHistory: true,
      });

      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("turn/start", {
          threadId,
          input: buildTurnInput(body, "text"),
          ...buildTurnConfig(project, body, selection),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "name") {
      const body = await parseJsonBody(request);
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/name/set", {
          threadId: decodeURIComponent(parts[2]),
          name: cleanString(body.name),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "fork") {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/fork", {
          threadId: decodeURIComponent(parts[2]),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "archive") {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/archive", {
          threadId: decodeURIComponent(parts[2]),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "unarchive") {
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("thread/unarchive", {
          threadId: decodeURIComponent(parts[2]),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "compact") {
      sendJson(response, 200, {
        ok: true,
        data: await threadActionHelpers.requestThreadActionWithResumeRetry("thread/compact/start", {
          threadId: decodeURIComponent(parts[2]),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "interrupt") {
      const body = await parseJsonBody(request);
      sendJson(response, 200, {
        ok: true,
        data: await bridge.request("turn/interrupt", {
          threadId: decodeURIComponent(parts[2]),
          turnId: cleanString(body.turnId),
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "threads" && parts[3] === "review") {
      const body = await parseJsonBody(request);
      sendJson(response, 200, {
        ok: true,
        data: await threadActionHelpers.requestThreadActionWithResumeRetry("review/start", {
          threadId: decodeURIComponent(parts[2]),
          target: parseReviewTarget(body),
          delivery: body.delivery === "detached" ? "detached" : "inline",
        }),
      });
      return;
    }

    if (request.method === "POST" && parts[1] === "server-requests" && parts[3] === "respond") {
      const body = await parseJsonBody(request);
      const requestId = decodeURIComponent(parts[2]);
      const pendingRequest = bridge.listPendingServerRequests().find((item) => String(item.id) === requestId);

      if (!pendingRequest) {
        throw new Error("Pending request not found");
      }

      await bridge.respondToServerRequest(pendingRequest.id, body.result);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendError(response, 404, "Not found");
  };
}

module.exports = {
  createApiHandler,
};
