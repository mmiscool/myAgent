class ServerRequestTracker {
  constructor() {
    this.turnToThread = new Map();
    this.itemToThread = new Map();
  }

  observeNotification(message) {
    const params = message?.params || {};
    const threadId = this.extractThreadId(params);

    if (!threadId) {
      return;
    }

    const turnId = this.extractTurnId(params);
    const itemId = this.extractItemId(params);

    if (turnId) {
      this.turnToThread.set(turnId, threadId);
    }

    if (itemId) {
      this.itemToThread.set(itemId, threadId);
    }
  }

  normalizeRequest(request) {
    if (!request || typeof request !== "object") {
      return request;
    }

    const params = request.params && typeof request.params === "object" ? request.params : {};
    const threadId = this.inferThreadId(params);

    if (!threadId || params.threadId === threadId) {
      return request;
    }

    return {
      ...request,
      params: {
        ...params,
        threadId,
      },
    };
  }

  inferThreadId(params) {
    return this.extractThreadId(params)
      || this.turnToThread.get(this.extractTurnId(params) || "")
      || this.itemToThread.get(this.extractItemId(params) || "")
      || "";
  }

  extractThreadId(params) {
    return cleanId(params?.threadId) || cleanId(params?.thread?.id);
  }

  extractTurnId(params) {
    return cleanId(params?.turnId) || cleanId(params?.turn?.id);
  }

  extractItemId(params) {
    return cleanId(params?.itemId) || cleanId(params?.item?.id);
  }
}

function cleanId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  ServerRequestTracker,
};
