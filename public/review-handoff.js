// Display-only helpers. Identity, assignment and review authority stay on the server.
export function reviewerChoices(workspace) {
  const authentication = workspace.authentication ?? {};
  return [
    ...(authentication.reviewerClientIds ?? []).map(id => ({id, kind:'agent', role:'Agent reviewer'})),
    ...(authentication.reviewerSubjects ?? []).map(id => ({id, kind:'human', role:'Human reviewer'})),
  ].map(option => ({...option, name:Object.hasOwn(workspace.reviewerNames??{},option.id) ? workspace.reviewerNames[option.id] : `${option.role} · ${option.id.slice(0,8)}…${option.id.slice(-6)}`}));
}

export function reviewRequestLabel(state) {
  return ({unassigned:'Choose reviewers',pending:'Awaiting review',pass:'Passed',changes_requested:'Changes requested',
    stale:'Needs renewed assignment',closed:'Candidate closed',
    'reviewer-unavailable':'Reviewer access needs attention'})[state] ?? 'Refresh review status';
}

export function humanReviewLink(origin, pathname, workspaceId, runId, assignmentId) {
  const url = new URL(pathname.startsWith('/workspace/') ? '/workspace/reviewer' : '/reviewer.html', origin);
  url.search = new URLSearchParams({workspace:workspaceId,run:runId,assignment:assignmentId}).toString();
  return url.href;
}

export function linkedReview(search, inbox) {
  const params = new URLSearchParams(search);
  if (!['workspace','run','assignment'].some(key => params.has(key))) return {kind:'none'};
  if (['workspace','run','assignment'].some(key => params.getAll(key).length !== 1 || !params.get(key))
    || params.get('workspace') !== inbox.workspaceId) return {kind:'unavailable'};
  const item = inbox.items.find(item => item.runId === params.get('run'));
  if (!item) return {kind:'unavailable'};
  if (item.assignmentId !== params.get('assignment') || ['stale','closed','reviewer-unavailable'].includes(item.status)) return {kind:'stale'};
  return {kind:'ready',item};
}
