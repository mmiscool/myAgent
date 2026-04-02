const path = require("path");

function projectPathKey(cwd) {
  let normalized = path.normalize(String(cwd || "").trim() || ".");

  if (normalized.length > 1) {
    normalized = normalized.replace(/[\\/]+$/g, "");
  }

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function mergeDuplicateProjects(existing, candidate) {
  const preferred = candidate?.id === "workspace" && existing?.id !== "workspace"
    ? candidate
    : existing;
  const secondary = preferred === existing ? candidate : existing;
  const createdAt = Math.min(
    Number.isFinite(existing?.createdAt) ? Number(existing.createdAt) : Date.now(),
    Number.isFinite(candidate?.createdAt) ? Number(candidate.createdAt) : Date.now(),
  );
  const updatedAt = Math.max(
    Number.isFinite(existing?.updatedAt) ? Number(existing.updatedAt) : 0,
    Number.isFinite(candidate?.updatedAt) ? Number(candidate.updatedAt) : 0,
  );

  return {
    ...secondary,
    ...preferred,
    createdAt,
    updatedAt,
  };
}

function dedupeProjectsByPath(projects) {
  const deduped = [];
  const indexByPath = new Map();

  for (const project of Array.isArray(projects) ? projects : []) {
    const key = projectPathKey(project?.cwd);

    if (!indexByPath.has(key)) {
      indexByPath.set(key, deduped.length);
      deduped.push(project);
      continue;
    }

    const existingIndex = indexByPath.get(key);
    deduped[existingIndex] = mergeDuplicateProjects(deduped[existingIndex], project);
  }

  return deduped;
}

module.exports = {
  dedupeProjectsByPath,
  mergeDuplicateProjects,
  projectPathKey,
};
