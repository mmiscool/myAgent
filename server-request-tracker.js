class ServerRequestTracker {
  constructor() {
    this.turnToThread = new Map();
    this.itemToThread = new Map();
    this.requestObservations = new Map();
  }

  reset() {
    this.turnToThread.clear();
    this.itemToThread.clear();
    this.requestObservations.clear();
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

  observeRequest(request) {
    const requestId = cleanRequestKey(request?.id);
    const receivedAt = Date.now();

    if (!requestId) {
      return {
        requestId: "",
        occurrence: 0,
        isDuplicate: false,
        isPendingReplay: false,
        wasResolved: false,
        firstSeenAt: receivedAt,
        receivedAt,
      };
    }

    const previous = this.requestObservations.get(requestId);
    const observation = {
      requestId,
      occurrence: (previous?.occurrence || 0) + 1,
      isDuplicate: Boolean(previous),
      isPendingReplay: Boolean(previous && !previous.resolvedAt),
      wasResolved: Boolean(previous?.resolvedAt),
      firstSeenAt: previous?.firstSeenAt || receivedAt,
      receivedAt,
      resolvedAt: null,
    };

    this.requestObservations.set(requestId, observation);

    return {
      requestId: observation.requestId,
      occurrence: observation.occurrence,
      isDuplicate: observation.isDuplicate,
      isPendingReplay: observation.isPendingReplay,
      wasResolved: observation.wasResolved,
      firstSeenAt: observation.firstSeenAt,
      receivedAt: observation.receivedAt,
    };
  }

  resolveRequest(requestId) {
    const requestKey = cleanRequestKey(requestId);

    if (!requestKey) {
      return;
    }

    const previous = this.requestObservations.get(requestKey);
    if (!previous) {
      return;
    }

    this.requestObservations.set(requestKey, {
      ...previous,
      resolvedAt: Date.now(),
    });
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

function cleanRequestKey(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return "";
}

module.exports = {
  ServerRequestTracker,
};
