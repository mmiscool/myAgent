export function threadActivityTimestamp(thread) {
  const value = Number(thread?.updatedAt ?? thread?.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function projectActivityTimestamp(projectId, projectThreads) {
  const threads = Array.isArray(projectThreads?.[projectId]) ? projectThreads[projectId] : [];
  return threads.reduce((latest, thread) => Math.max(latest, threadActivityTimestamp(thread)), 0);
}

export function sortProjectsByRecentConversationActivity(projects, projectThreads) {
  const list = Array.isArray(projects) ? projects.slice() : [];
  const originalOrder = new Map(list.map((project, index) => [project?.id || `project-${index}`, index]));

  return list.sort((left, right) => {
    const activityDiff = projectActivityTimestamp(right?.id, projectThreads) - projectActivityTimestamp(left?.id, projectThreads);
    if (activityDiff !== 0) {
      return activityDiff;
    }

    return (originalOrder.get(left?.id) ?? 0) - (originalOrder.get(right?.id) ?? 0);
  });
}
