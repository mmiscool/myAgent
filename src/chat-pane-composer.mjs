export function createChatPaneComposer({
  state,
  elements,
  standaloneMode,
  bridge,
  api,
  cleanString,
  escapeHtml,
  formatServiceTierLabel,
  resolveComposerSelection,
  supportedReasoningEffortsForModel,
  supportedServiceTiersForModel,
  normalizeRalphLoopLimit,
}) {
  let monacoLoadPromise = null;
  let composerEditor = null;
  let composerEditorPromise = null;
  let composerMonaco = null;
  let composerEditorModel = null;
  let suppressEditorChange = false;

  async function ensureMonaco() {
    if (composerMonaco) {
      return composerMonaco;
    }

    if (!monacoLoadPromise) {
      monacoLoadPromise = Promise.all([
        import("monaco-editor"),
        import("monaco-editor/esm/vs/editor/editor.worker?worker"),
        import("monaco-editor/esm/vs/language/json/json.worker?worker"),
        import("monaco-editor/esm/vs/language/css/css.worker?worker"),
        import("monaco-editor/esm/vs/language/html/html.worker?worker"),
        import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      ]).then(([
        monaco,
        editorWorkerModule,
        jsonWorkerModule,
        cssWorkerModule,
        htmlWorkerModule,
        tsWorkerModule,
      ]) => {
        const editorWorker = editorWorkerModule.default || editorWorkerModule;
        const jsonWorker = jsonWorkerModule.default || jsonWorkerModule;
        const cssWorker = cssWorkerModule.default || cssWorkerModule;
        const htmlWorker = htmlWorkerModule.default || htmlWorkerModule;
        const tsWorker = tsWorkerModule.default || tsWorkerModule;

        globalThis.MonacoEnvironment = {
          getWorker(_workerId, label) {
            if (label === "json") {
              return new jsonWorker();
            }

            if (label === "css" || label === "scss" || label === "less") {
              return new cssWorker();
            }

            if (label === "html" || label === "handlebars" || label === "razor") {
              return new htmlWorker();
            }

            if (label === "typescript" || label === "javascript") {
              return new tsWorker();
            }

            return new editorWorker();
          },
        };

        composerMonaco = monaco;
        return monaco;
      });
    }

    return monacoLoadPromise;
  }

  function syncComposerDraftText(text) {
    state.composer.draftText = text || "";
    bridge.send("composer-draft", { text: state.composer.draftText });
  }

  function updateComposerEditorEmptyState() {
    const container = document.getElementById("chatPromptInput");
    if (container instanceof HTMLElement) {
      container.classList.toggle("empty", !(state.composer.draftText || ""));
    }
  }

  function useMonacoComposer() {
    return state.composer.useMonaco !== false;
  }

  function disposeComposerEditor() {
    if (composerEditor) {
      composerEditor.dispose();
      composerEditor = null;
    }
    composerEditorPromise = null;
  }

  async function ensureComposerEditor(snapshot) {
    if (composerEditor) {
      return composerEditor;
    }

    if (composerEditorPromise) {
      return composerEditorPromise;
    }

    const container = document.getElementById("chatPromptInput");
    if (!(container instanceof HTMLElement)) {
      return null;
    }

    composerEditorPromise = (async () => {
      const monaco = await ensureMonaco();
      if (!document.body.contains(container)) {
        return null;
      }

      if (!composerEditorModel || composerEditorModel.isDisposed?.()) {
        composerEditorModel = monaco.editor.createModel(state.composer.draftText || "", "markdown");
      } else if (composerEditorModel.getValue() !== (state.composer.draftText || "")) {
        suppressEditorChange = true;
        composerEditorModel.setValue(state.composer.draftText || "");
        suppressEditorChange = false;
      }
      monaco.editor.setModelLanguage(composerEditorModel, "markdown");

      const disabled = standaloneMode ? !state.threadId : !state.projectId;
      updateComposerEditorEmptyState();
      const editor = monaco.editor.create(container, {
        automaticLayout: true,
        contextmenu: false,
        fontFamily: "\"SFMono-Regular\", Menlo, Consolas, monospace",
        fontSize: 13,
        lineDecorationsWidth: 0,
        lineNumbers: "off",
        lineNumbersMinChars: 0,
        minimap: { enabled: false },
        model: composerEditorModel,
        overviewRulerBorder: false,
        readOnly: disabled,
        renderLineHighlight: "none",
        scrollbar: {
          alwaysConsumeMouseWheel: false,
          horizontal: "hidden",
          verticalScrollbarSize: 8,
        },
        scrollBeyondLastLine: false,
        theme: "vs-dark",
        wordWrap: "on",
      });

      editor.onDidChangeModelContent(() => {
        if (suppressEditorChange) {
          return;
        }

        syncComposerDraftText(editor.getValue());
        updateComposerEditorEmptyState();
      });

      composerEditor = editor;

      if (snapshot?.focused) {
        editor.focus();
        if (snapshot.selection) {
          editor.setSelection(snapshot.selection);
        } else if (snapshot.position) {
          editor.setPosition(snapshot.position);
        }
      }

      return editor;
    })().finally(() => {
      composerEditorPromise = null;
    });

    return composerEditorPromise;
  }

  function currentStandaloneComposerModel() {
    return state.models.find((model) => model.id === state.composerModel) || null;
  }

  function formatEffortLabel(effort) {
    switch (effort) {
      case "xhigh":
        return "Extra High";
      case "high":
        return "High";
      case "medium":
        return "Medium";
      case "low":
        return "Low";
      case "minimal":
        return "Minimal";
      case "none":
        return "None";
      default:
        return effort;
    }
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

  function persistStandaloneComposerSettings() {
    localStorage.setItem("composerModel", state.composerModel || "");
    localStorage.setItem("composerEffort", state.composerEffort || "");
    localStorage.setItem("composerServiceTier", state.composerServiceTier || "");
    localStorage.setItem("composerMode", state.composer.mode === "plan" ? "plan" : "default");
    localStorage.setItem("composerUseMonaco", String(state.composer.useMonaco !== false));
    localStorage.setItem("composerApproveAllDangerous", String(state.composer.approveAllDangerous));
    localStorage.setItem("composerRalphLoop", String(state.composer.ralphLoop));
    localStorage.setItem("composerRalphLoopLimit", String(state.composer.ralphLoopLimit));
  }

  function normalizeStandaloneComposerSettings() {
    const selection = resolveComposerSelection({
      models: state.models,
      requestedModelId: state.composerModel,
      requestedEffort: state.composerEffort,
      requestedServiceTier: state.composerServiceTier,
      capabilities: state.composerCapabilities,
    });

    state.composerModel = selection.modelId;
    state.composerEffort = selection.effort;
    state.composerServiceTier = selection.serviceTier;
    state.composer.ralphLoopLimit = normalizeRalphLoopLimit(state.composer.ralphLoopLimit);
    if (!["default", "plan"].includes(state.composer.mode)) {
      state.composer.mode = "default";
    }
    state.composer.useMonaco = state.composer.useMonaco !== false;
    state.composer.modeLabel = state.composer.mode === "plan" ? "Plan" : "Chat";
  }

  function buildStandaloneComposerViewState() {
    normalizeStandaloneComposerSettings();

    const model = currentStandaloneComposerModel();
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

    const defaultReasoningEffort = cleanString(
      model?.defaultReasoningEffort
      || model?.default_reasoning_effort
      || model?.defaultReasoningLevel
      || model?.default_reasoning_level,
    );
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
        <span class="composer-picker-item-label">${escapeHtml(formatEffortLabel(entry.reasoningEffort))}${entry.reasoningEffort === defaultReasoningEffort ? " (default)" : ""}</span>
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
      mode: state.composer.mode === "plan" ? "plan" : "default",
      modeLabel: state.composer.mode === "plan" ? "Plan" : "Chat",
      useMonaco: state.composer.useMonaco !== false,
      approveAllDangerous: state.composer.approveAllDangerous,
      ralphLoop: state.composer.ralphLoop,
      ralphLoopLimit: state.composer.ralphLoopLimit,
    };
  }

  function snapshotComposerInputState() {
    if (composerEditor) {
      return {
        focused: composerEditor.hasTextFocus(),
        position: composerEditor.getPosition(),
        selection: composerEditor.getSelection(),
      };
    }

    const input = document.getElementById("chatPromptInput");

    if (!(input instanceof HTMLElement)) {
      return null;
    }

    if (input instanceof HTMLTextAreaElement) {
      return {
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        scrollTop: input.scrollTop,
      };
    }

    return {
      focused: document.activeElement === input,
    };
  }

  function restoreComposerInputState(snapshot) {
    if (!useMonacoComposer()) {
      requestAnimationFrame(() => {
        const input = document.getElementById("chatPromptInput");
        if (!(input instanceof HTMLTextAreaElement)) {
          return;
        }

        if (snapshot?.focused) {
          input.focus();
        }

        if (
          Number.isInteger(snapshot?.selectionStart)
          && Number.isInteger(snapshot?.selectionEnd)
        ) {
          input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }

        if (Number.isFinite(snapshot?.scrollTop)) {
          input.scrollTop = snapshot.scrollTop;
        }
      });
      return;
    }

    requestAnimationFrame(() => {
      void ensureComposerEditor(snapshot).catch((error) => {
        console.error("Failed to initialize composer editor", error);
      });
    });
  }

  function renderComposerAttachments() {
    if (!state.composer.attachments.length) {
      return "";
    }

    return `
      <div class="composer-attachments">
        ${state.composer.attachments.map((attachment) => `
          <figure class="composer-attachment">
            <button
              type="button"
              class="composer-attachment-preview"
              data-action="open-composer-attachment"
              data-id="${escapeHtml(attachment.id)}"
              title="${escapeHtml(attachment.name || "Pasted image")}"
            >
              <img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachment.name || "Pasted image")}" class="composer-attachment-image">
            </button>
            <button
              type="button"
              class="composer-attachment-remove"
              data-action="remove-composer-attachment"
              data-id="${escapeHtml(attachment.id)}"
              title="Remove image"
              aria-label="Remove image"
            >×</button>
          </figure>
        `).join("")}
      </div>
    `;
  }

  function renderComposer() {
    if (standaloneMode) {
      state.composer = {
        ...state.composer,
        ...buildStandaloneComposerViewState(),
      };
    }

    const inputSnapshot = snapshotComposerInputState();
    const modelMenuOpen = state.ui.composerMenuOpen === "model";
    const effortMenuOpen = state.ui.composerMenuOpen === "effort";
    const disabled = standaloneMode ? !state.threadId : !state.projectId;
    const sendInFlight = state.composer.sendInFlight === true;
    const useMonaco = useMonacoComposer();
    disposeComposerEditor();

    elements.chatPaneComposer.innerHTML = `
      <form class="composer" data-action="composer-form">
        ${renderComposerAttachments()}
        ${useMonaco
          ? `<div
              id="chatPromptInput"
              class="chat-prompt-editor${state.composer.draftText ? "" : " empty"}"
              data-placeholder="Ask Codex to inspect, edit, review, search, run commands, or delegate inside the selected project."
              role="textbox"
              aria-label="Chat prompt"
              aria-multiline="true"
              ${disabled ? 'aria-disabled="true"' : ""}
            ></div>`
          : `<textarea
              id="chatPromptInput"
              class="chat-prompt-textarea"
              name="text"
              rows="5"
              placeholder="Ask Codex to inspect, edit, review, search, run commands, or delegate inside the selected project."
              aria-label="Chat prompt"
              ${disabled ? "disabled" : ""}
            >${escapeHtml(state.composer.draftText || "")}</textarea>`}
        <div class="composer-row composer-footer">
          <button type="submit" class="primary-button" ${(disabled || sendInFlight) ? "disabled" : ""}>${sendInFlight ? "Sending..." : "Send"}</button>
          <div class="composer-settings">
            <button
              type="button"
              class="ghost-button composer-settings-button"
              data-action="toggle-composer-settings"
              aria-haspopup="menu"
              aria-expanded="${state.ui.composerSettingsOpen ? "true" : "false"}"
              ${disabled ? "disabled" : ""}
            >Settings</button>
            <div class="composer-settings-menu ${state.ui.composerSettingsOpen ? "" : "hidden"}" aria-label="Composer settings">
              <div class="composer-controls">
                <div class="composer-picker">
                  <button type="button" class="composer-picker-trigger" data-action="toggle-composer-menu" data-menu="model" aria-haspopup="listbox" aria-expanded="${modelMenuOpen ? "true" : "false"}" ${state.composer.hasModelOptions ? "" : "disabled"}>
                    <span class="composer-picker-icon" aria-hidden="true">◎</span>
                    <span class="composer-picker-label">${escapeHtml(state.composer.modelLabel)}</span>
                  </button>
                  <div class="composer-picker-menu ${modelMenuOpen ? "" : "hidden"}" role="listbox" aria-label="Model">${state.composer.modelMenuHtml}</div>
                </div>
                <div class="composer-picker">
                  <button type="button" class="composer-picker-trigger" data-action="toggle-composer-menu" data-menu="effort" aria-haspopup="listbox" aria-expanded="${effortMenuOpen ? "true" : "false"}" ${state.composer.hasEffortOptions ? "" : "disabled"}>
                    <span class="composer-picker-label">${escapeHtml(state.composer.effortLabel)}</span>
                  </button>
                  <div class="composer-picker-menu ${effortMenuOpen ? "" : "hidden"}" role="listbox" aria-label="Reasoning">${state.composer.effortMenuHtml}</div>
                </div>
                <button type="button" class="composer-mode-button ${state.composer.mode === "plan" ? "plan" : ""}" data-action="toggle-composer-mode" aria-pressed="${state.composer.mode === "plan" ? "true" : "false"}">${escapeHtml(state.composer.modeLabel)}</button>
                <label class="composer-toggle composer-toggle-inline">
                  <input id="chatComposerUseMonacoToggle" type="checkbox" ${useMonaco ? "checked" : ""} ${disabled ? "disabled" : ""}>
                  <span>Monaco editor</span>
                </label>
                <button type="button" class="composer-toggle composer-toggle-inline composer-dangerous-toggle" data-action="toggle-approve-all-dangerous" aria-pressed="${state.composer.approveAllDangerous ? "true" : "false"}">
                  <span aria-hidden="true">${state.composer.approveAllDangerous ? "☑" : "☐"}</span>
                  <span>Approve all dangerous</span>
                </button>
                <button type="button" class="composer-toggle composer-toggle-inline composer-ralph-loop-toggle" data-action="toggle-ralph-loop" aria-pressed="${state.composer.ralphLoop ? "true" : "false"}">
                  <span aria-hidden="true">${state.composer.ralphLoop ? "☑" : "☐"}</span>
                  <span>Ralph loop</span>
                </button>
                <label class="composer-number-control composer-ralph-loop-limit">
                  <span class="composer-number-control-copy">
                    <span class="composer-number-control-label">Ralph loop count</span>
                    <span class="composer-number-control-hint">0 keeps looping until you stop it</span>
                  </span>
                  <input
                    id="chatRalphLoopLimitInput"
                    class="composer-number-input"
                    type="number"
                    min="0"
                    step="1"
                    inputmode="numeric"
                    value="${escapeHtml(String(state.composer.ralphLoopLimit))}"
                    ${disabled ? "disabled" : ""}
                  >
                </label>
              </div>
            </div>
          </div>
        </div>
      </form>
    `;

    restoreComposerInputState(inputSnapshot);
  }

  function updateComposerSetting(key, value) {
    if (key === "approveAllDangerous") {
      state.composer.approveAllDangerous = value === true;
      state.approveAllDangerous = state.composer.approveAllDangerous;
      if (standaloneMode) {
        persistStandaloneComposerSettings();
      }
    } else if (key === "ralphLoop") {
      state.composer.ralphLoop = value === true;
      if (standaloneMode) {
        persistStandaloneComposerSettings();
      }
    } else if (key === "ralphLoopLimit") {
      state.composer.ralphLoopLimit = normalizeRalphLoopLimit(value);
      if (standaloneMode) {
        persistStandaloneComposerSettings();
      }
    } else if (key === "mode") {
      state.composer.mode = value === "plan" ? "plan" : "default";
      state.composer.modeLabel = state.composer.mode === "plan" ? "Plan" : "Chat";
      if (standaloneMode) {
        persistStandaloneComposerSettings();
      }
    } else if (key === "useMonaco") {
      state.composer.useMonaco = value !== false;
      if (standaloneMode) {
        persistStandaloneComposerSettings();
      }
    } else if (key === "model") {
      state.composerModel = cleanString(value);
      if (standaloneMode) {
        normalizeStandaloneComposerSettings();
        persistStandaloneComposerSettings();
      }
    } else if (key === "effort") {
      state.composerEffort = cleanString(value);
      if (standaloneMode) {
        normalizeStandaloneComposerSettings();
        persistStandaloneComposerSettings();
      }
    } else if (key === "serviceTier") {
      state.composerServiceTier = cleanString(value);
      if (standaloneMode) {
        normalizeStandaloneComposerSettings();
        persistStandaloneComposerSettings();
      }
    }

    if (!standaloneMode) {
      bridge.send("composer-setting", { key, value });
    }
  }

  async function sendComposerMessage() {
    if (standaloneMode && !state.threadId) {
      return;
    }

    const payload = {
      text: state.composer.draftText || "",
      images: state.composer.attachments.map((attachment) => ({
        type: "image",
        url: attachment.url,
        name: attachment.name,
      })),
    };

    if (standaloneMode) {
      const model = currentStandaloneComposerModel();
      const modelId = model?.id || state.composerModel || undefined;
      const reasoningEffort = state.composerEffort || undefined;
      await api(`/api/threads/${encodeURIComponent(state.threadId)}/message`, {
        method: "POST",
        body: {
          projectId: state.projectId,
          text: payload.text,
          images: payload.images,
          model: modelId,
          effort: reasoningEffort,
          serviceTier: state.composerServiceTier || undefined,
          collaborationMode: modelId
            ? {
              mode: state.composer.mode === "plan" ? "plan" : "default",
              settings: {
                model: modelId,
                reasoning_effort: reasoningEffort || undefined,
              },
            }
            : undefined,
        },
      });
      state.composer.draftText = "";
      state.composer.attachments = [];
      renderComposer();
      return;
    }

    bridge.send("send-message", payload);
  }

  function focusComposerInput() {
    if (!useMonacoComposer()) {
      const input = document.getElementById("chatPromptInput");
      if (input instanceof HTMLTextAreaElement) {
        input.focus();
      }
      return;
    }

    if (composerEditor) {
      composerEditor.focus();
      return;
    }

    void ensureComposerEditor({ focused: true }).then((editor) => {
      editor?.focus();
    }).catch((error) => {
      console.error("Failed to focus composer editor", error);
    });
  }

  function getActiveComposerDraftText() {
    if (!useMonacoComposer()) {
      const input = document.getElementById("chatPromptInput");
      if (input instanceof HTMLTextAreaElement && document.activeElement === input) {
        return input.value || "";
      }
      return undefined;
    }

    if (!composerEditor?.hasTextFocus()) {
      return undefined;
    }

    return composerEditor.getValue() || "";
  }

  function isComposerInputEventTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest("#chatPromptInput"));
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read pasted image"));
      reader.readAsDataURL(file);
    });
  }

  async function loadStandaloneComposerState() {
    const payload = await api("/api/models");
    state.models = Array.isArray(payload.data) ? payload.data : [];
    state.composerCapabilities = payload.capabilities || { serviceTiers: [], defaultServiceTier: "" };
    normalizeStandaloneComposerSettings();
  }

  return {
    focusComposerInput,
    getActiveComposerDraftText,
    isComposerInputEventTarget,
    loadStandaloneComposerState,
    readFileAsDataUrl,
    renderComposer,
    sendComposerMessage,
    updateComposerSetting,
  };
}

function normalizeComposerAttachment(attachment = {}) {
  return {
    id: attachment?.id || "",
    name: attachment?.name || "",
    url: attachment?.url || "",
  };
}

export function normalizeComposerAttachments(attachments = []) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.map((attachment) => normalizeComposerAttachment(attachment));
}

export function mergeIncomingHostComposerState(currentComposer = {}, incomingComposer = {}, { draftTextOverride } = {}) {
  const nextComposer = {
    ...currentComposer,
    ...(incomingComposer && typeof incomingComposer === "object" ? incomingComposer : {}),
  };

  nextComposer.attachments = Array.isArray(incomingComposer?.attachments)
    ? normalizeComposerAttachments(incomingComposer.attachments)
    : normalizeComposerAttachments(currentComposer.attachments);

  if (typeof draftTextOverride === "string") {
    nextComposer.draftText = draftTextOverride;
  }

  return nextComposer;
}

export function captureHostComposerRenderState(state = {}) {
  const composer = state?.composer || {};

  return {
    projectId: state?.projectId || "",
    threadId: state?.threadId || "",
    composer: {
      draftText: composer.draftText || "",
      attachments: normalizeComposerAttachments(composer.attachments),
      sendInFlight: composer.sendInFlight === true,
      modelLabel: composer.modelLabel || "",
      effortLabel: composer.effortLabel || "",
      hasModelOptions: composer.hasModelOptions === true,
      hasEffortOptions: composer.hasEffortOptions === true,
      modelMenuHtml: composer.modelMenuHtml || "",
      effortMenuHtml: composer.effortMenuHtml || "",
      mode: composer.mode === "plan" ? "plan" : "default",
      modeLabel: composer.modeLabel || "",
      useMonaco: composer.useMonaco !== false,
      approveAllDangerous: composer.approveAllDangerous === true,
      ralphLoop: composer.ralphLoop === true,
      ralphLoopLimit: String(composer.ralphLoopLimit ?? ""),
    },
  };
}
