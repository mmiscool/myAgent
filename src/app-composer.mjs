export function createAppComposer({
  state,
  elements,
  actions,
  api,
  cleanString,
  escapeHtml,
  formatServiceTierLabel,
  oneLine,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
  composerApprovalPolicyOverride,
  RALPH_LOOP_DELAY_SECONDS,
  startRalphLoopCountdown,
  consumeRalphLoopBudget,
  createRalphLoopBudget,
  findLatestRalphLoopInput,
  hasRalphLoopBudgetRemaining,
  isLiveStatus,
  latestTurn,
  normalizeRalphLoopInput,
  normalizeRalphLoopLimit,
  createThreadTab,
  replaceProjectTab,
  openProjectThreadTab,
  activeProjectTab,
  syncSelectedProjectThreadTab,
  draftStorageKey,
}) {
  function persistComposerSettings() {
    localStorage.setItem("composerModel", state.composerModel || "");
    localStorage.setItem("composerEffort", state.composerEffort || "");
    localStorage.setItem("composerServiceTier", state.composerServiceTier || "");
    localStorage.setItem("composerMode", state.composerMode || "default");
    localStorage.setItem("composerApproveAllDangerous", String(state.composerApproveAllDangerous));
    localStorage.setItem("composerRalphLoopLimit", String(state.composerRalphLoopLimit));
  }

  function restoreComposerDraft() {
    elements.promptInput.value = localStorage.getItem(draftStorageKey) || "";
  }

  function persistComposerDraft() {
    localStorage.setItem(draftStorageKey, elements.promptInput.value || "");
  }

  function clearComposerDraft() {
    localStorage.removeItem(draftStorageKey);
  }

  function currentComposerModel() {
    return state.models.find((model) => model.id === state.composerModel) || null;
  }

  function currentProjectDefaultModel() {
    const project = actions.selectedProject?.();
    if (!project?.defaultModel) {
      return null;
    }

    return state.models.find((model) => model.id === project.defaultModel) || null;
  }

  function fallbackComposerModel() {
    return currentProjectDefaultModel()
      || state.models.find((model) => model.isDefault)
      || state.models[0]
      || null;
  }

  function normalizeComposerSettings() {
    const selection = resolveComposerSelection({
      models: state.models,
      requestedModelId: state.composerModel,
      fallbackModelId: actions.selectedProject?.()?.defaultModel || "",
      requestedEffort: state.composerEffort,
      requestedServiceTier: state.composerServiceTier,
      capabilities: state.composerCapabilities,
    });

    state.composerModel = selection.modelId;
    state.composerEffort = selection.effort;
    state.composerServiceTier = selection.serviceTier;
    state.composerRalphLoopLimit = normalizeRalphLoopLimit(state.composerRalphLoopLimit);

    if (!["default", "plan"].includes(state.composerMode)) {
      state.composerMode = "default";
    }

    persistComposerSettings();
  }

  function formatEffortLabel(effort) {
    if (effort === "xhigh") {
      return "Extra High";
    }

    if (effort === "high") {
      return "High";
    }

    if (effort === "medium") {
      return "Medium";
    }

    if (effort === "low") {
      return "Low";
    }

    if (effort === "minimal") {
      return "Minimal";
    }

    if (effort === "none") {
      return "None";
    }

    return effort;
  }

  function formatComposerSettingsLabel(reasoningEffort, serviceTier) {
    const labels = [];

    if (reasoningEffort) {
      labels.push(formatEffortLabel(reasoningEffort));
    }

    if (serviceTier) {
      labels.push(formatServiceTierLabel(serviceTier));
    }

    return labels.join(" · ") || "Reasoning";
  }

  function buildComposerViewState() {
    const model = currentComposerModel();
    const reasoningOptions = supportedReasoningEffortsForModel(model);
    const supportedEfforts = reasoningOptions.map((entry) => entry.reasoningEffort);
    const supportedServiceTiers = supportedServiceTiersForModel(model, state.composerCapabilities);
    const hasModelOptions = state.models.length > 0;
    const hasEffortOptions = supportedEfforts.length > 0 || supportedServiceTiers.length > 0;
    const modelMenuHtml = hasModelOptions
      ? state.models.map((entry) => `
        <button
          type="button"
          class="composer-picker-item${entry.id === state.composerModel ? " active" : ""}"
          data-action="select-composer-model"
          data-value="${escapeHtml(entry.id)}"
          role="option"
          aria-selected="${entry.id === state.composerModel ? "true" : "false"}"
        >
          <span class="composer-picker-check" aria-hidden="true">${entry.id === state.composerModel ? "✓" : ""}</span>
          <span class="composer-picker-item-label">${escapeHtml(entry.displayName || entry.id)}</span>
        </button>
      `).join("")
      : '<div class="composer-picker-empty">No models available</div>';

    const reasoningMarkup = reasoningOptions.map((entry) => `
      <button
        type="button"
        class="composer-picker-item${entry.reasoningEffort === state.composerEffort ? " active" : ""}"
        data-action="select-composer-effort"
        data-value="${escapeHtml(entry.reasoningEffort)}"
        role="option"
        aria-selected="${entry.reasoningEffort === state.composerEffort ? "true" : "false"}"
      >
        <span class="composer-picker-check" aria-hidden="true">${entry.reasoningEffort === state.composerEffort ? "✓" : ""}</span>
        <span class="composer-picker-item-label">${escapeHtml(formatEffortLabel(entry.reasoningEffort))}${entry.reasoningEffort === model?.defaultReasoningEffort ? " (default)" : ""}</span>
      </button>
    `).join("");
    const serviceTierMarkup = supportedServiceTiers.length > 0
      ? `
        ${reasoningMarkup ? '<div class="composer-picker-divider" aria-hidden="true"></div>' : ""}
        <div class="composer-picker-section">Service Tier</div>
        <button
          type="button"
          class="composer-picker-item${!state.composerServiceTier ? " active" : ""}"
          data-action="select-composer-service-tier"
          data-value=""
          role="option"
          aria-selected="${!state.composerServiceTier ? "true" : "false"}"
        >
          <span class="composer-picker-check" aria-hidden="true">${!state.composerServiceTier ? "✓" : ""}</span>
          <span class="composer-picker-item-label">Auto</span>
        </button>
        ${supportedServiceTiers.map((serviceTier) => `
          <button
            type="button"
            class="composer-picker-item${serviceTier === state.composerServiceTier ? " active" : ""}"
            data-action="select-composer-service-tier"
            data-value="${escapeHtml(serviceTier)}"
            role="option"
            aria-selected="${serviceTier === state.composerServiceTier ? "true" : "false"}"
          >
            <span class="composer-picker-check" aria-hidden="true">${serviceTier === state.composerServiceTier ? "✓" : ""}</span>
            <span class="composer-picker-item-label">${escapeHtml(formatServiceTierLabel(serviceTier))}</span>
          </button>
        `).join("")}
      `
      : "";

    const effortMenuHtml = reasoningMarkup || serviceTierMarkup
      ? `${reasoningMarkup}${serviceTierMarkup}`
      : '<div class="composer-picker-empty">No settings available for this model</div>';

    return {
      modelLabel: model?.displayName || model?.id || state.composerModel || "Select Model",
      effortLabel: formatComposerSettingsLabel(state.composerEffort, state.composerServiceTier),
      hasModelOptions,
      hasEffortOptions,
      modelMenuHtml,
      effortMenuHtml,
      mode: state.composerMode === "plan" ? "plan" : "default",
      modeLabel: state.composerMode === "plan" ? "Plan" : "Chat",
      approveAllDangerous: state.composerApproveAllDangerous,
      ralphLoop: state.composerRalphLoop,
      ralphLoopLimit: state.composerRalphLoopLimit,
    };
  }

  function renderComposerControls() {
    normalizeComposerSettings();

    const composerView = buildComposerViewState();
    const modelMenuOpen = state.composerMenuOpen === "model";
    const effortMenuOpen = state.composerMenuOpen === "effort";

    if (!elements.composerModelLabel) {
      actions.syncAllPaneFrames?.();
      return;
    }

    elements.composerModelLabel.textContent = composerView.modelLabel;
    elements.composerEffortLabel.textContent = composerView.effortLabel;
    elements.composerModelButton.disabled = !composerView.hasModelOptions;
    elements.composerEffortButton.disabled = !composerView.hasEffortOptions;
    elements.composerModelMenu.innerHTML = composerView.modelMenuHtml;
    elements.composerEffortMenu.innerHTML = composerView.effortMenuHtml;
    elements.composerSettingsMenu.classList.toggle("hidden", !state.composerSettingsOpen);
    elements.composerSettingsButton.setAttribute("aria-expanded", state.composerSettingsOpen ? "true" : "false");
    elements.composerModelMenu.classList.toggle("hidden", !modelMenuOpen);
    elements.composerEffortMenu.classList.toggle("hidden", !effortMenuOpen);
    elements.composerModelButton.setAttribute("aria-expanded", modelMenuOpen ? "true" : "false");
    elements.composerEffortButton.setAttribute("aria-expanded", effortMenuOpen ? "true" : "false");
    elements.composerModeButton.textContent = composerView.modeLabel;
    elements.composerModeButton.classList.toggle("plan", composerView.mode === "plan");
    elements.composerModeButton.setAttribute("aria-pressed", composerView.mode === "plan" ? "true" : "false");
    elements.approveAllDangerousToggle.checked = composerView.approveAllDangerous;
    elements.ralphLoopToggle.checked = composerView.ralphLoop;
    elements.ralphLoopLimitInput.value = String(composerView.ralphLoopLimit);
    const submitButton = elements.composerForm?.querySelector('button[type="submit"]');
    if (submitButton) {
      submitButton.disabled = state.manualSendInFlight;
      submitButton.textContent = state.manualSendInFlight ? "Sending..." : "Send";
    }
    actions.syncAllPaneFrames?.();
  }

  function composerRequestOverrides() {
    const model = currentComposerModel() || fallbackComposerModel();
    const modelId = model?.id || state.composerModel || undefined;
    const reasoningEffort = state.composerEffort || model?.defaultReasoningEffort || undefined;
    const overrides = {
      approvalPolicy: composerApprovalPolicyOverride(
        actions.selectedProject?.()?.approvalPolicy,
        state.composerApproveAllDangerous,
      ),
      model: modelId,
      effort: reasoningEffort,
      serviceTier: state.composerServiceTier || undefined,
    };

    if (modelId) {
      overrides.collaborationMode = {
        mode: state.composerMode === "plan" ? "plan" : "default",
        settings: {
          model: modelId,
          reasoning_effort: reasoningEffort || null,
        },
      };
    }

    return overrides;
  }

  function currentComposerInput() {
    return normalizeRalphLoopInput({
      text: elements.promptInput.value,
      images: state.composerAttachments.map((attachment) => ({
        type: "image",
        url: attachment.url,
        name: attachment.name,
      })),
    });
  }

  function pendingThreadPreview(input) {
    const text = oneLine(input?.text || "");

    if (text) {
      return text.slice(0, 120);
    }

    const imageCount = Array.isArray(input?.images) ? input.images.length : 0;
    if (imageCount > 0) {
      return imageCount === 1 ? "Image message" : `${imageCount} images`;
    }

    return "New conversation";
  }

  function currentRalphLoopInput(threadId) {
    const normalizedThreadId = String(threadId || "");

    if (!normalizedThreadId || normalizedThreadId !== state.selectedThreadId) {
      return null;
    }

    const currentInput = currentComposerInput();
    if (currentInput.text || currentInput.images.length > 0) {
      return currentInput;
    }

    if (state.selectedThread?.id === normalizedThreadId) {
      return findLatestRalphLoopInput(state.selectedThread);
    }

    return null;
  }

  function isRalphLoopActiveForThread(threadId) {
    return state.composerRalphLoop
      && state.activeThreadTab === "chat"
      && Boolean(threadId)
      && threadId === state.selectedThreadId
      && Boolean(state.selectedThread?.id);
  }

  function currentPendingRalphLoopReplay(threadId) {
    const normalizedThreadId = String(threadId || "");
    const pendingReplay = state.ralphLoopPendingReplay;

    if (!pendingReplay || pendingReplay.threadId !== normalizedThreadId) {
      return null;
    }

    return pendingReplay;
  }

  function setRalphLoopBudget(threadId) {
    const normalizedThreadId = cleanString(threadId);
    state.ralphLoopBudget = normalizedThreadId
      ? createRalphLoopBudget(state.composerRalphLoopLimit, normalizedThreadId)
      : null;
  }

  function clearRalphLoopBudget() {
    state.ralphLoopBudget = null;
  }

  function syncConfiguredRalphLoopBudget() {
    const budgetThreadId = cleanString(state.ralphLoopBudget?.threadId);

    if (!budgetThreadId || budgetThreadId !== state.selectedThreadId) {
      return;
    }

    if (!state.composerRalphLoop) {
      clearRalphLoopBudget();
      return;
    }

    setRalphLoopBudget(budgetThreadId);
  }

  function cancelPendingRalphLoop({ disableLoop = false, render = true, cancelAutoCompact = false } = {}) {
    const pendingReplay = state.ralphLoopPendingReplay;
    state.ralphLoopPendingReplay = null;

    if (cancelAutoCompact) {
      state.ralphLoopAutoCompactThreadId = "";
    }

    if (pendingReplay?.cancel) {
      pendingReplay.cancel();
    }

    if (disableLoop) {
      state.composerRalphLoop = false;
      elements.ralphLoopToggle.checked = false;
    }

    if (disableLoop || cancelAutoCompact) {
      clearRalphLoopBudget();
    }

    if (render) {
      actions.renderConversation?.();
    } else {
      renderRalphLoopDialog(null);
    }

    if (disableLoop) {
      renderComposerControls();
    }
  }

  function syncPendingRalphLoopReplay() {
    const pendingReplay = state.ralphLoopPendingReplay;

    if (!pendingReplay) {
      return;
    }

    if (!isRalphLoopActiveForThread(pendingReplay.threadId)) {
      cancelPendingRalphLoop({ render: false, cancelAutoCompact: true });
    }
  }

  function syncModalOpenState() {
    const hasOpenModal = state.imageEditor.open || !elements.ralphLoopModal.classList.contains("hidden");
    document.body.classList.toggle("modal-open", hasOpenModal);
  }

  function renderRalphLoopDialog(pendingReplay = currentPendingRalphLoopReplay(state.selectedThread?.id || state.selectedThreadId)) {
    const visible = Boolean(pendingReplay);
    elements.ralphLoopModal.classList.toggle("hidden", !visible);
    elements.ralphLoopModal.setAttribute("aria-hidden", visible ? "false" : "true");

    if (!visible) {
      syncModalOpenState();
      return;
    }

    const remainingSeconds = Math.max(0, Number(pendingReplay.remainingSeconds) || 0);
    const durationText = `${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`;
    elements.ralphLoopCountdownValue.textContent = durationText;
    elements.ralphLoopCountdownNumber.textContent = String(remainingSeconds);
    elements.ralphLoopCountdownLabel.textContent = remainingSeconds === 1 ? "second remaining" : "seconds remaining";
    syncModalOpenState();
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }

  async function readThreadSnapshot(threadId) {
    const payload = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    return payload.data?.thread || payload.data || null;
  }

  function threadHasLiveWork(thread) {
    return isLiveStatus(thread?.status) || isLiveStatus(latestTurn(thread)?.status);
  }

  async function autoCompactRalphLoopThread(threadId, previousTurnId = "") {
    const normalizedThreadId = String(threadId || "");

    if (!normalizedThreadId) {
      return false;
    }

    state.ralphLoopAutoCompactThreadId = normalizedThreadId;

    try {
      await api(`/api/threads/${encodeURIComponent(normalizedThreadId)}/compact`, {
        method: "POST",
        body: {},
      });

      const startDeadline = Date.now() + 5000;
      const completionDeadline = Date.now() + 60000;
      let compactStarted = false;

      while (Date.now() < completionDeadline) {
        if (state.ralphLoopAutoCompactThreadId !== normalizedThreadId) {
          return false;
        }

        if (!isRalphLoopActiveForThread(normalizedThreadId)) {
          return false;
        }

        const thread = await readThreadSnapshot(normalizedThreadId);
        const latest = latestTurn(thread);
        const latestTurnChanged = Boolean(latest?.id) && latest.id !== previousTurnId;
        const liveWork = threadHasLiveWork(thread);

        compactStarted = compactStarted || latestTurnChanged || liveWork;

        if (compactStarted && !liveWork) {
          if (state.selectedThreadId === normalizedThreadId) {
            await actions.loadThread?.(normalizedThreadId);
          }
          return true;
        }

        if (!compactStarted && Date.now() >= startDeadline) {
          if (state.selectedThreadId === normalizedThreadId) {
            await actions.loadThread?.(normalizedThreadId);
          }
          return true;
        }

        await sleep(400);
      }

      if (state.selectedThreadId === normalizedThreadId) {
        await actions.loadThread?.(normalizedThreadId);
      }

      return true;
    } finally {
      if (state.ralphLoopAutoCompactThreadId === normalizedThreadId) {
        state.ralphLoopAutoCompactThreadId = "";
      }
    }
  }

  async function waitForRalphLoopReplay(threadId, completedTurnId = "") {
    cancelPendingRalphLoop({ render: false });

    const normalizedThreadId = String(threadId || "");
    if (!normalizedThreadId) {
      return false;
    }

    const replayKey = `${normalizedThreadId}:${completedTurnId || "latest"}:${Date.now()}`;
    const countdown = startRalphLoopCountdown({
      seconds: RALPH_LOOP_DELAY_SECONDS,
      onTick: (remainingSeconds) => {
        if (state.ralphLoopPendingReplay?.key !== replayKey) {
          return;
        }

        state.ralphLoopPendingReplay.remainingSeconds = remainingSeconds;
        actions.renderConversation?.();
      },
    });

    state.ralphLoopPendingReplay = {
      key: replayKey,
      threadId: normalizedThreadId,
      completedTurnId: completedTurnId || "",
      remainingSeconds: RALPH_LOOP_DELAY_SECONDS,
      cancel: countdown.cancel,
    };
    actions.renderConversation?.();

    const completed = await countdown.done;

    if (state.ralphLoopPendingReplay?.key === replayKey) {
      state.ralphLoopPendingReplay = null;
      actions.renderConversation?.();
    }

    return completed;
  }

  async function sendConversationMessage(input, options = {}) {
    const project = actions.selectedProject?.();
    const activeTab = activeProjectTab(project?.id);
    const normalizedInput = normalizeRalphLoopInput(input);
    const overrides = composerRequestOverrides();
    const fromRalphLoop = options.fromRalphLoop === true;
    const manualSend = !fromRalphLoop;
    const startingNewThread = manualSend && !state.selectedThreadId;

    if (!project) {
      throw new Error("Select a project first");
    }

    if (!normalizedInput.text && normalizedInput.images.length === 0) {
      throw new Error("Enter a prompt or paste an image");
    }

    if (!fromRalphLoop) {
      cancelPendingRalphLoop({ render: false, cancelAutoCompact: true });
    }

    if (manualSend && state.manualSendInFlight) {
      throw new Error("A message is already being sent");
    }

    if (activeTab?.pane && activeTab.pane !== "chat") {
      throw new Error("Switch to a conversation tab before sending a message");
    }

    if (manualSend) {
      state.manualSendInFlight = true;
      renderComposerControls();
    }

    if (startingNewThread) {
      state.pendingNewThread = {
        projectId: project.id,
        title: pendingThreadPreview(normalizedInput),
        input: normalizedInput,
      };
      actions.renderProjects?.();
      actions.renderThreadHeader?.();
      actions.renderConversation?.();
    }

    try {
      if (state.selectedThreadId) {
        await api(`/api/threads/${encodeURIComponent(state.selectedThreadId)}/message`, {
          method: "POST",
          body: { projectId: project.id, text: normalizedInput.text, images: normalizedInput.images, ...overrides },
        });
      } else {
        const created = await api("/api/threads", {
          method: "POST",
          body: { projectId: project.id, prompt: normalizedInput.text, images: normalizedInput.images, ...overrides },
        });

        state.selectedThreadId = created.data?.thread?.id || "";
        if (state.selectedThreadId) {
          const nextTab = createThreadTab(project.id, state.selectedThreadId);
          if (activeTab?.pane === "chat" && !cleanString(activeTab.threadId)) {
            replaceProjectTab(project.id, activeTab.id, nextTab);
          } else {
            openProjectThreadTab(project.id, state.selectedThreadId, { activate: true });
          }
          syncSelectedProjectThreadTab();
        }
      }

      actions.persistSelection?.();
      actions.syncAllPaneFrames?.();
      await actions.loadAllProjectThreads?.();
      actions.renderProjects?.();

      if (state.selectedThreadId) {
        await actions.loadThread?.(state.selectedThreadId);
      }

      if (!fromRalphLoop) {
        if (state.composerRalphLoop && state.selectedThreadId) {
          setRalphLoopBudget(state.selectedThreadId);
        } else {
          clearRalphLoopBudget();
        }
      }

      return state.selectedThreadId;
    } finally {
      if (startingNewThread) {
        state.pendingNewThread = null;
      }
      if (manualSend) {
        state.manualSendInFlight = false;
        renderComposerControls();
        actions.renderProjects?.();
        actions.renderThreadHeader?.();
        actions.renderConversation?.();
      }
    }
  }

  async function maybeRunRalphLoop(threadId, completedTurnId = "") {
    if (!isRalphLoopActiveForThread(threadId)) {
      return;
    }

    if (!hasRalphLoopBudgetRemaining(state.ralphLoopBudget, threadId)) {
      return;
    }

    if (completedTurnId && state.ralphLoopLastCompletedTurnId === completedTurnId) {
      return;
    }

    if (!currentRalphLoopInput(threadId)) {
      return;
    }

    state.ralphLoopLastCompletedTurnId = completedTurnId || state.ralphLoopLastCompletedTurnId;

    try {
      const shouldReplay = await waitForRalphLoopReplay(threadId, completedTurnId);

      if (!shouldReplay || !isRalphLoopActiveForThread(threadId)) {
        return;
      }

      if (!currentRalphLoopInput(threadId)) {
        return;
      }

      const compacted = await autoCompactRalphLoopThread(threadId, completedTurnId);
      if (!compacted || !isRalphLoopActiveForThread(threadId)) {
        return;
      }

      const replayInput = currentRalphLoopInput(threadId);
      if (!replayInput) {
        return;
      }

      if (!hasRalphLoopBudgetRemaining(state.ralphLoopBudget, threadId)) {
        return;
      }

      await sendConversationMessage(replayInput, { fromRalphLoop: true });
      state.ralphLoopBudget = consumeRalphLoopBudget(state.ralphLoopBudget, threadId);
    } catch (error) {
      console.error("Ralph loop failed", error);
    }
  }

  return {
    buildComposerViewState,
    cancelPendingRalphLoop,
    clearComposerDraft,
    currentComposerInput,
    currentPendingRalphLoopReplay,
    currentRalphLoopInput,
    maybeRunRalphLoop,
    normalizeComposerSettings,
    persistComposerDraft,
    persistComposerSettings,
    renderComposerControls,
    renderRalphLoopDialog,
    restoreComposerDraft,
    sendConversationMessage,
    setRalphLoopBudget,
    syncConfiguredRalphLoopBudget,
    syncModalOpenState,
    syncPendingRalphLoopReplay,
  };
}
