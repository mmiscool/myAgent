import { escapeHtml } from "./ui-formatters.mjs";

export function commandApprovalDecisionLabel(decision) {
  if (typeof decision === "string") {
    switch (decision) {
      case "accept":
        return "Allow";
      case "acceptForSession":
        return "Allow For Session";
      case "decline":
        return "Decline";
      case "cancel":
        return "Cancel";
      default:
        return decision;
    }
  }

  if (decision?.acceptWithExecpolicyAmendment) {
    return "Allow With Policy";
  }

  if (decision?.applyNetworkPolicyAmendment) {
    return "Allow Network Policy";
  }

  return "Respond";
}

export function createConversationUi({ renderMarkdown, renderCollapsibleItem, normalizeCommandApprovalDecisions }) {
  function renderContentEntry(entry) {
    if (typeof entry === "string") {
      return renderMarkdown(entry);
    }

    if (!entry || typeof entry !== "object") {
      return "";
    }

    if (entry.type === "text") {
      return renderMarkdown(entry.text || "");
    }

    if (entry.type === "inputText") {
      return `<pre>${escapeHtml(entry.text || "")}</pre>`;
    }

    const imageUrl = entry.url || entry.imageUrl || entry.image_url || entry.data;

    if ((entry.type === "image" || entry.type === "local_image" || entry.type === "localImage" || entry.type === "inputImage") && imageUrl) {
      return `
        <figure class="message-image-wrap">
          <img class="message-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(entry.alt || entry.name || "Attached image")}">
        </figure>
      `;
    }

    return `<pre>${escapeHtml(`[${entry.type || "content"}] ${entry.path || imageUrl || entry.name || ""}`)}</pre>`;
  }

  function renderMessageContent(items, fallbackText = "") {
    if (!Array.isArray(items) || items.length === 0) {
      return renderMarkdown(fallbackText || "");
    }

    return items.map((entry) => renderContentEntry(entry)).join("");
  }

  function renderToolCallBody(item) {
    const metadata = [];

    if (item?.id) {
      metadata.push(`id: ${item.id}`);
    }

    if (item?.tool) {
      metadata.push(`tool: ${item.tool}`);
    }

    if (item?.status) {
      metadata.push(`status: ${item.status}`);
    }

    if (item?.arguments && Object.keys(item.arguments).length > 0) {
      metadata.push(`arguments:\n${JSON.stringify(item.arguments, null, 2)}`);
    }

    const contentItems = Array.isArray(item?.contentItems) ? item.contentItems : [];
    const sections = [];

    if (metadata.length > 0) {
      sections.push(`<pre data-role="body">${escapeHtml(metadata.join("\n\n"))}</pre>`);
    }

    if (contentItems.length > 0) {
      sections.push(`<div class="message-body tool-call-content">${renderMessageContent(contentItems)}</div>`);
    }

    if (!sections.length) {
      sections.push(`<pre data-role="body">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`);
    }

    return `<div class="tool-call-body">${sections.join("")}</div>`;
  }

  function renderPendingServerRequest(request) {
    if (!request?.method) {
      return "";
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
      const body = questions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const fieldId = `pending-${escapeHtml(String(request.id))}-${escapeHtml(question.id || String(index))}`;
        const useSelect = options.length > 0;
        const allowOther = Boolean(question.isOther);

        return `
          <label class="pending-request-field" for="${fieldId}">
            <span class="pending-request-label">${escapeHtml(question.header || question.id || `Question ${index + 1}`)}</span>
            <span class="pending-request-help">${escapeHtml(question.question || "")}</span>
            ${useSelect ? `
              <select id="${fieldId}" name="${escapeHtml(question.id || `question_${index}`)}" class="pending-request-input" ${allowOther ? `data-has-other="true" data-other-target="${fieldId}-other"` : ""}>
                <option value="">Select an answer</option>
                ${options.map((option) => `<option value="${escapeHtml(option.label || "")}">${escapeHtml(option.label || "")}</option>`).join("")}
                ${allowOther ? `<option value="__other__">Other</option>` : ""}
              </select>
            ` : `
              <input id="${fieldId}" name="${escapeHtml(question.id || `question_${index}`)}" class="pending-request-input" type="${question.isSecret ? "password" : "text"}" autocomplete="off">
            `}
            ${allowOther ? `<input id="${fieldId}-other" name="${escapeHtml(question.id || `question_${index}`)}__other" class="pending-request-input hidden" type="${question.isSecret ? "password" : "text"}" autocomplete="off" placeholder="Enter another answer">` : ""}
          </label>
        `;
      }).join("");

      return `
        <article class="bubble agent pending-request-card">
          <strong>Input Required</strong>
          <div class="message-body">
            <form data-action="respond-tool-request-user-input" data-request-id="${escapeHtml(String(request.id))}">
              ${body}
              <div class="pending-request-actions">
                <button type="submit">Send Response</button>
              </div>
            </form>
          </div>
        </article>
      `;
    }

    if (request.method === "item/commandExecution/requestApproval") {
      const decisions = normalizeCommandApprovalDecisions(request.params?.availableDecisions);
      const reason = request.params?.reason || "";
      const command = request.params?.command || "";
      const cwd = request.params?.cwd || "";
      const hasDetails = Boolean(reason || command || cwd);

      return `
        <article class="bubble agent pending-request-card">
          <strong>Command Approval</strong>
          <div class="message-body">
            ${hasDetails ? "" : "<p>This approval request arrived without command details. You can still allow or decline it.</p>"}
            ${reason ? `<p>${escapeHtml(reason)}</p>` : ""}
            ${command ? `<pre>${escapeHtml(command)}</pre>` : ""}
            ${cwd ? `<p><strong>cwd</strong> ${escapeHtml(cwd)}</p>` : ""}
            <div class="pending-request-actions">
              ${decisions.map((decision) => {
                const value = typeof decision === "string" ? decision : JSON.stringify(decision);
                return `<button type="button" data-action="respond-command-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="${escapeHtml(value)}">${escapeHtml(commandApprovalDecisionLabel(decision))}</button>`;
              }).join("")}
            </div>
          </div>
        </article>
      `;
    }

    if (request.method === "item/fileChange/requestApproval") {
      const reason = request.params?.reason || "Approve file changes?";
      const grantRoot = request.params?.grantRoot || "";

      return `
        <article class="bubble agent pending-request-card">
          <strong>File Change Approval</strong>
          <div class="message-body">
            <p>${escapeHtml(reason)}</p>
            ${grantRoot ? `<p><strong>root</strong> ${escapeHtml(grantRoot)}</p>` : ""}
            <div class="pending-request-actions">
              <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="accept">Allow</button>
              <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="acceptForSession">Allow For Session</button>
              <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="decline">Decline</button>
              <button type="button" data-action="respond-file-change-approval" data-request-id="${escapeHtml(String(request.id))}" data-decision="cancel">Cancel</button>
            </div>
          </div>
        </article>
      `;
    }

    if (request.method === "item/permissions/requestApproval") {
      const reason = request.params?.reason || "Grant additional permissions?";
      const details = request.params?.permissions ? escapeHtml(JSON.stringify(request.params.permissions, null, 2)) : "";

      return `
        <article class="bubble agent pending-request-card">
          <strong>Permissions Approval</strong>
          <div class="message-body">
            <p>${escapeHtml(reason)}</p>
            ${details ? `<pre>${details}</pre>` : ""}
            <div class="pending-request-actions">
              <button type="button" data-action="respond-permissions-approval" data-request-id="${escapeHtml(String(request.id))}" data-scope="turn">Grant For Turn</button>
              <button type="button" data-action="respond-permissions-approval" data-request-id="${escapeHtml(String(request.id))}" data-scope="session">Grant For Session</button>
            </div>
          </div>
        </article>
      `;
    }

    return renderCollapsibleItem({
      id: request.id || request.method,
      type: "pendingRequest",
    }, {
      title: "Pending Request",
      summary: request.method,
      body: JSON.stringify(request, null, 2),
    });
  }

  return {
    renderContentEntry,
    renderMessageContent,
    renderToolCallBody,
    renderPendingServerRequest,
  };
}
