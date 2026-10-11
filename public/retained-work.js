import { candidateOutcome, taskOutcome, independentlyVerified, locationSearch } from './workbench-state.js';

// Show the matching passage instead of always clipping a review note off the end.
export function retainedWorkSnippet(text, query = '') {
  const source = String(text ?? ''), phrase = query.trim();
  // Match an escaped literal against the original text: lowercasing can expand
  // Unicode characters and make its offsets invalid for the original source.
  const position = term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu').exec(source)?.index ?? -1;
  let match = phrase ? position(phrase) : -1;
  if (match < 0 && phrase) {
    const positions = phrase.split(/\s+/).map(position).filter(index => index >= 0);
    if (positions.length) match = Math.min(...positions);
  }
  let start = match > 180 ? Math.max(0, match - Math.min(60, Math.max(0, 240 - phrase.length))) : 0;
  // Keep UTF-16 surrogate pairs intact at both crop boundaries.
  if (start && /[\uDC00-\uDFFF]/.test(source[start])) start--;
  let end = Math.min(source.length, start + 240);
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end])) end--;
  return (start ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '');
}

// Search only the records already available in the selected project. No source
// checkout, logs, credentials, provider call or workflow mutation is involved.
export function searchRetainedWork(workspace, projectId, query = '') {
  if (!Object.hasOwn(workspace.projects ?? {}, projectId)) throw new Error('Project is not in this workspace.');
  const terms = query.trim().slice(0, 200).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const records = [];
  for (const task of [...workspace.tasks].reverse()) {
    if (task.projectId !== projectId) continue;
    const runs = workspace.runs.filter(run => run.taskId === task.id && run.headCommit).reverse();
    for (const run of runs.length ? runs : [null]) {
      const fields = [
        ['Task', task.title], ['Purpose', task.purpose], ['Criteria', (task.criteria ?? []).join(' · ')], ['Task ID', task.id],
        ['Candidate', run?.label], ['Summary', run?.summary], ['Changed filenames', (run?.changedFiles ?? []).join(' · ')],
        ['Commit', run?.headCommit], ['Candidate ID', run?.id], ['Review note', run?.review?.note],
      ].filter(([, value]) => typeof value === 'string' && value.length);
      const text = fields.map(([, value]) => value).join('\n').toLocaleLowerCase();
      const matches = terms.every(term => text.includes(term));
      const matchedFields = terms.length ? fields.filter(([, value]) => terms.some(term => value.toLocaleLowerCase().includes(term))).map(([label]) => label) : [];
      const report = run?.evidence;
      const current = Boolean(run && independentlyVerified(workspace, run));
      const proof = !run ? 'No committed candidate yet' : run.verificationPending ? 'Verification running'
        : !report ? 'No check report' : `${report.passed} / ${report.total} reported checks · ${current ? 'current independent evidence' : 'not current independent evidence'}`;
      records.push({ task, run, matches, matchedFields, proof,
        outcome: run ? candidateOutcome(workspace, run) : taskOutcome(workspace, task),
        href: locationSearch(run ? 'review' : 'work', task.id, run?.id) });
    }
  }
  return { total: records.length, items: records.filter(record => record.matches) };
}

// Index results describe a matched historical identity. Current readiness is
// always derived again from the loaded authoritative workspace, never a score.
export function indexedSearchResults(workspace, projectId, documents) {
  if (!Object.hasOwn(workspace.projects ?? {}, projectId)) throw new Error('Project is not in this workspace.');
  return documents.flatMap(doc => {
    if (doc.workspaceId !== workspace.id || doc.projectId !== projectId) throw new Error('Search result belongs to another workspace or project.');
    const task = workspace.tasks.find(task => task.id === doc.taskId && task.projectId === projectId);
    const run = doc.runId ? workspace.runs.find(run => run.id === doc.runId && run.taskId === doc.taskId) : null;
    if (!task || doc.runId && !run) return [];
    const historical = doc.taskRevision !== (task.revision ?? 1) || Boolean(run && doc.headCommit !== run.headCommit);
    const current = Boolean(run && independentlyVerified(workspace, run));
    const proof = historical ? 'Historical match · inspect current requirements and evidence before reuse'
      : !run ? 'Task brief · no candidate verification implied'
      : run.verificationPending ? 'Verification running'
      : !run.evidence ? 'No check report'
      : `${run.evidence.passed} / ${run.evidence.total} reported checks · ${current ? 'current independent evidence' : 'not current independent evidence'}`;
    return [{ task, run, proof, outcome: run ? candidateOutcome(workspace, run) : taskOutcome(workspace, task),
      href: locationSearch(run ? 'review' : 'work', task.id, run?.id), matchedFields: [], matchedRevision: doc.taskRevision,
      matchedHead: doc.headCommit, snippet: doc.text, historical, score: doc.score }];
  });
}
