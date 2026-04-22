import "./styles.css";
import "monaco-editor/min/vs/editor/editor.main.css";
import { api, cleanString, createPaneBridge, escapeHtml } from "./pane-bridge.mjs";

let monacoLoadPromise = null;

const state = {
  active: false,
  resource: null,
  editor: null,
  editorPromise: null,
  monaco: null,
};

const elements = {
  title: document.getElementById("threadResourceTitle"),
  status: document.getElementById("threadResourceStatus"),
  openRaw: document.getElementById("threadResourceOpenRaw"),
  reload: document.getElementById("threadResourceReload"),
  close: document.getElementById("threadResourceClose"),
  empty: document.getElementById("threadResourceEmpty"),
  editor: document.getElementById("threadResourceEditor"),
  preview: document.getElementById("threadResourcePreview"),
};

const bridge = createPaneBridge("resource", {
  onState: (payload) => {
    void applyHostState(payload);
  },
  onFocus: () => {
    void focusActiveResource();
  },
});

elements.openRaw.addEventListener("click", () => {
  if (state.resource?.viewUrl) {
    window.open(state.resource.viewUrl, "_blank", "noopener,noreferrer");
  }
});

elements.reload.addEventListener("click", () => {
  void loadResource();
});

elements.close.addEventListener("click", () => {
  bridge.send("close-resource", { resourceId: state.resource?.id || "" });
});

async function applyHostState(payload = {}) {
  state.active = payload.active === true;
  const incomingResource = payload.resource && typeof payload.resource === "object"
    ? payload.resource
    : null;
  const resourceChanged = incomingResource?.id !== state.resource?.id || incomingResource?.path !== state.resource?.path;
  const nextResource = incomingResource
    ? {
      ...(resourceChanged ? {} : (state.resource || {})),
      ...incomingResource,
    }
    : null;

  if (!nextResource) {
    clearResourceState();
    renderResourcePane();
    return;
  }

  if (resourceChanged && state.resource?.model) {
    state.resource.model.dispose();
  }

  state.resource = nextResource;
  renderResourcePane();

  if (resourceChanged || state.resource.kind == null) {
    await loadResource();
    return;
  }

  if (state.active) {
    await focusActiveResource();
  }
}

function clearResourceState() {
  if (state.resource?.saveTimer) {
    clearTimeout(state.resource.saveTimer);
  }

  if (state.editor?.getModel()) {
    state.editor.setModel(null);
  }

  state.resource?.model?.dispose?.();
  state.resource = null;
}

function describeResourceStatus(resource) {
  if (!resource) {
    return "";
  }

  if (resource.loading && resource.kind === "loading") {
    return "Loading file…";
  }

  if (resource.loading) {
    return "Reloading from disk…";
  }

  if (!resource.writable) {
    return "Read-only text file";
  }

  if (resource.saveState === "error") {
    return `Save failed: ${resource.error || "unknown error"}`;
  }

  if (resource.saveState === "saving") {
    return "Saving…";
  }

  return "";
}

function renderResourcePane() {
  const resource = state.resource;
  const hasResource = Boolean(resource);

  elements.openRaw.disabled = !hasResource || !resource.viewUrl;
  elements.reload.disabled = !hasResource || resource.loading;
  elements.close.disabled = !hasResource;

  if (!resource) {
    elements.title.textContent = "Open a file link to preview it here.";
    elements.status.textContent = "Text files open in Monaco and save as you type. Images render inline.";
    elements.empty.classList.remove("hidden");
    elements.editor.classList.add("hidden");
    elements.preview.classList.add("hidden");
    elements.preview.innerHTML = "";
    return;
  }

  elements.title.textContent = resource.path || resource.name || "Resource";
  elements.status.textContent = describeResourceStatus(resource);

  if (resource.error) {
    elements.empty.classList.remove("hidden");
    elements.empty.textContent = resource.error;
    elements.editor.classList.add("hidden");
    elements.preview.classList.add("hidden");
    elements.preview.innerHTML = "";
    return;
  }

  if (resource.loading && resource.kind === "loading") {
    elements.empty.classList.remove("hidden");
    elements.empty.textContent = "Loading file…";
    elements.editor.classList.add("hidden");
    elements.preview.classList.add("hidden");
    elements.preview.innerHTML = "";
    return;
  }

  if (resource.kind === "image" && resource.viewUrl) {
    elements.empty.classList.add("hidden");
    elements.editor.classList.add("hidden");
    elements.preview.classList.remove("hidden");
    elements.preview.innerHTML = `<img class="thread-resource-image" src="${escapeHtml(resource.viewUrl)}" alt="${escapeHtml(resource.name || "Resource preview")}">`;
    return;
  }

  if (resource.kind === "binary") {
    elements.empty.classList.add("hidden");
    elements.editor.classList.add("hidden");
    elements.preview.classList.remove("hidden");
    elements.preview.innerHTML = `
      <div class="thread-resource-binary">
        <p>This file can’t be edited as text in Monaco.</p>
        ${resource.viewUrl ? `<a href="${escapeHtml(resource.viewUrl)}" target="_blank" rel="noreferrer">Open the raw file in a new tab</a>` : ""}
      </div>
    `;
    return;
  }

  elements.empty.classList.add("hidden");
  elements.preview.classList.add("hidden");
  elements.preview.innerHTML = "";
  elements.editor.classList.remove("hidden");
  void syncActiveResourceEditor();
}

async function ensureMonaco() {
  if (state.monaco) {
    return state.monaco;
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

      state.monaco = monaco;
      return monaco;
    });
  }

  return monacoLoadPromise;
}

async function ensureResourceEditor() {
  if (state.editor) {
    return state.editor;
  }

  if (!state.editorPromise) {
    state.editorPromise = (async () => {
      const monaco = await ensureMonaco();
      const editor = monaco.editor.create(elements.editor, {
        automaticLayout: true,
        fontFamily: "\"SFMono-Regular\", Menlo, Consolas, monospace",
        fontSize: 13,
        lineNumbersMinChars: 4,
        minimap: { enabled: false },
        readOnly: true,
        scrollBeyondLastLine: false,
        theme: "vs-dark",
      });

      editor.onDidChangeModelContent(() => {
        const resource = state.resource;

        if (!resource || resource.suppressModelChange || !resource.writable) {
          return;
        }

        scheduleResourceSave();
      });

      state.editor = editor;
      return editor;
    })().finally(() => {
      state.editorPromise = null;
    });
  }

  return state.editorPromise;
}

function scheduleResourceSave() {
  const resource = state.resource;
  if (!resource?.model || !resource.writable) {
    return;
  }

  clearTimeout(resource.saveTimer);
  resource.saveState = "dirty";
  renderResourcePane();
  resource.saveTimer = window.setTimeout(() => {
    void flushResourceSave();
  }, 250);
}

async function flushResourceSave() {
  const resource = state.resource;

  if (!resource?.model || !resource.writable) {
    return;
  }

  clearTimeout(resource.saveTimer);
  resource.saveTimer = 0;

  if (resource.saveInFlight) {
    resource.saveQueued = true;
    return;
  }

  resource.saveInFlight = true;
  resource.saveState = "saving";
  resource.error = "";
  renderResourcePane();

  try {
    const payload = await api("/api/file", {
      method: "PUT",
      body: {
        path: resource.path,
        text: resource.model.getValue(),
        expectedMtimeMs: resource.mtimeMs,
      },
    });

    resource.mtimeMs = Number(payload.data?.mtimeMs) || resource.mtimeMs;
    resource.size = Number(payload.data?.size) || resource.size;
    resource.saveState = "saved";
  } catch (error) {
    resource.saveState = "error";
    resource.error = error.message;
  } finally {
    resource.saveInFlight = false;
    renderResourcePane();
  }

  if (resource.saveQueued) {
    resource.saveQueued = false;
    void flushResourceSave();
  }
}

async function loadResource() {
  const resource = state.resource;

  if (!resource?.path) {
    renderResourcePane();
    return;
  }

  resource.loading = true;
  resource.kind = resource.kind || "loading";
  if (resource.kind === "loading") {
    resource.error = "";
  }
  renderResourcePane();

  try {
    const payload = await api(`/api/file?path=${encodeURIComponent(resource.path)}`);
    const data = payload.data || {};

    resource.name = data.name || resource.name;
    resource.kind = data.kind || "binary";
    resource.mimeType = data.mimeType || "";
    resource.size = Number(data.size) || 0;
    resource.mtimeMs = Number(data.mtimeMs) || 0;
    resource.writable = data.writable === true;
    resource.viewUrl = data.viewUrl || resource.viewUrl || "";
    resource.loading = false;
    resource.error = "";

    if (resource.kind === "text") {
      await upsertResourceModel(resource, data.text ?? "");
    } else if (resource.model) {
      resource.model.dispose();
      resource.model = null;
    }

    renderResourcePane();
    await focusActiveResource();
  } catch (error) {
    resource.loading = false;
    resource.error = error.message;
    renderResourcePane();
  }
}

async function upsertResourceModel(resource, text) {
  const monaco = await ensureMonaco();
  const uri = monaco.Uri.file(resource.path);
  const existingModel = resource.model || monaco.editor.getModel(uri);

  if (!existingModel) {
    resource.model = monaco.editor.createModel(String(text || ""), undefined, uri);
  } else {
    resource.suppressModelChange = true;
    existingModel.setValue(String(text || ""));
    resource.suppressModelChange = false;
    resource.model = existingModel;
  }

  resource.saveState = "idle";
}

async function syncActiveResourceEditor() {
  const resource = state.resource;

  if (!resource || resource.kind !== "text") {
    if (state.editor?.getModel()) {
      state.editor.setModel(null);
    }
    return;
  }

  const editor = await ensureResourceEditor();
  editor.updateOptions({ readOnly: !resource.writable });
  if (editor.getModel() !== resource.model) {
    editor.setModel(resource.model || null);
  }

  if (state.active) {
    editor.focus();
  }
}

async function focusActiveResource() {
  const resource = state.resource;

  if (!resource || !state.active) {
    return;
  }

  if (resource.kind === "text") {
    await syncActiveResourceEditor();
    state.editor?.focus();
    return;
  }

  elements.preview.focus?.();
}
