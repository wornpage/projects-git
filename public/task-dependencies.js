// Shared pure admission rule. Used by workflow mutations and presentation.
export function dependencyState(workspace, task) {
  const ids = task.dependsOn ?? []; // Existing saved tasks predate prerequisites.
  if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || id === task.id)) {
    return { ready: false, invalid: 'Invalid retained task prerequisites.', waiting: [], integrated: [] };
  }
  const waiting = [], integrated = [];
  for (const id of ids) {
    const prerequisite = workspace.tasks.find(item => item.id === id);
    if (!prerequisite || !task.projectId || prerequisite.projectId !== task.projectId) {
      return { ready: false, invalid: 'A prerequisite is missing or belongs to another project.', waiting, integrated };
    }
    const item = { id, title: prerequisite.title, mergedCommit: prerequisite.mergedCommit };
    if (typeof prerequisite.mergedCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(prerequisite.mergedCommit)) integrated.push(item);
    else waiting.push(item);
  }
  return { ready: waiting.length === 0, invalid: null, waiting, integrated };
}
