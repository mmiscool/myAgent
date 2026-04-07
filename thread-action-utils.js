function createThreadActionHelpers({
  bridge,
  findProjectByCwd,
  buildThreadConfig,
  cleanString,
  compactObject,
}) {
  async function readThreadMetadata(threadId) {
    const payload = await bridge.request("thread/read", {
      threadId,
      includeTurns: false,
    });

    return payload?.thread || payload || null;
  }

  async function resumeThreadForDetachedAction(threadId) {
    const normalizedThreadId = cleanString(threadId);

    if (!normalizedThreadId) {
      return;
    }

    const thread = await readThreadMetadata(normalizedThreadId);
    const cwd = cleanString(thread?.cwd);

    if (!cwd) {
      return;
    }

    const project = await findProjectByCwd(cwd).catch(() => null);
    const resumeParams = compactObject({
      threadId: normalizedThreadId,
      ...(project ? buildThreadConfig(project) : { cwd }),
      persistExtendedHistory: true,
    });

    await bridge.request("thread/resume", resumeParams);
  }

  async function requestThreadActionWithResumeRetry(method, params) {
    try {
      return await bridge.request(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!/thread not found:/i.test(message)) {
        throw error;
      }

      const threadId = cleanString(params?.threadId);

      if (!threadId) {
        throw error;
      }

      try {
        await resumeThreadForDetachedAction(threadId);
      } catch {
        throw error;
      }

      return bridge.request(method, params);
    }
  }

  return {
    readThreadMetadata,
    resumeThreadForDetachedAction,
    requestThreadActionWithResumeRetry,
  };
}

module.exports = {
  createThreadActionHelpers,
};
