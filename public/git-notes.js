// Portable recorded context. These records never participate in workflow decisions.
export const GIT_NOTES_REF = 'refs/notes/projects';
export const GIT_NOTE_FORMAT = 'projects-git-context/v1';
export const MAX_GIT_NOTE_BYTES = 32 * 1024;
export const MAX_GIT_NOTE_RECORDS = 16;
const encoder = new TextEncoder();
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digestId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 1;
const fields = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const contextFields = ['workspaceId','workspaceVersion','projectId','taskId','runId','taskTitle',
  'requirementsRevision','requirementsSha256','baseCommit','headCommit','recordedStatus',
  'summaryExcerpt','summaryTruncated','evidenceSha256','assessmentSha256','decisionSha256'];

function canonical(value, depth = 0) {
  if (depth > 32) throw new Error('Recorded context nesting exceeds its limit.');
  if (value === null || ['string','boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  throw new Error('Recorded context must contain finite JSON data.');
}
async function sha256(value) {
  const bytes = encoder.encode(canonical(value));
  if (bytes.length > 2 * 1024 * 1024) throw new Error('The source record exceeds the context digest limit.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
}
function validateContext(value, commit) {
  if (!fields(value, contextFields) || typeof value.workspaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.workspaceId)
    || !integer(value.workspaceVersion) || ![value.projectId,value.taskId,value.runId].every(uuid)
    || !text(value.taskTitle,300) || !value.taskTitle.trim() || !integer(value.requirementsRevision)
    || !digestId(value.requirementsSha256) || !oid(value.baseCommit) || value.headCommit !== commit
    || !['assigned','running','awaiting_review','accepted','rejected','merged','failed','superseded'].includes(value.recordedStatus)
    || !text(value.summaryExcerpt,1200) || typeof value.summaryTruncated !== 'boolean'
    || ![value.evidenceSha256,value.assessmentSha256,value.decisionSha256].every(item => item === null || digestId(item)))
    throw new Error('Invalid recorded Git context. It must identify one exact commit and retained task/run.');
}

export function serializeGitNote(note) {
  const serialized = JSON.stringify(note, null, 2) + '\n';
  if (encoder.encode(serialized).length > MAX_GIT_NOTE_BYTES) throw new Error('Git context exceeds 32 KiB; no records were truncated.');
  return serialized;
}
export async function readGitNote(input, expectedCommit) {
  if (typeof input !== 'string' || encoder.encode(input).length > MAX_GIT_NOTE_BYTES) throw new Error('Git context must be UTF-8 JSON within 32 KiB.');
  let note;
  try { note = JSON.parse(input); } catch { throw new Error('Git context is not valid JSON.'); }
  if (!fields(note,['format','commit','records']) || note.format !== GIT_NOTE_FORMAT || !oid(note.commit)
    || expectedCommit !== undefined && note.commit !== expectedCommit || !Array.isArray(note.records)
    || !note.records.length || note.records.length > MAX_GIT_NOTE_RECORDS)
    throw new Error('Unsupported Git context format, commit or record count.');
  const seen = new Set();
  for (const item of note.records) {
    if (!fields(item,['sha256','context']) || !digestId(item.sha256) || seen.has(item.sha256)) throw new Error('Invalid or duplicate Git context record.');
    validateContext(item.context,note.commit);
    if (await sha256(item.context) !== item.sha256) throw new Error('Git context checksum mismatch. A checksum is not authenticated provenance.');
    seen.add(item.sha256);
  }
  note.records.sort((a,b) => a.sha256.localeCompare(b.sha256));
  serializeGitNote(note);
  return note;
}

export async function buildGitNote(workspace, runId) {
  const run = workspace.runs.find(item => item.id === runId), task = workspace.tasks.find(item => item.id === run?.taskId);
  if (!task || !run || !oid(run.headCommit) || !workspace.projects?.[task.projectId]) throw new Error('Git context needs a retained project and an exact candidate commit.');
  // Capture selected values before hashing; unrelated workspace records never leave here.
  const summary = typeof run.summary === 'string' ? run.summary : '';
  const context = {workspaceId:workspace.id,workspaceVersion:workspace.version,projectId:task.projectId,taskId:task.id,runId:run.id,
    taskTitle:task.title,requirementsRevision:task.revision ?? 1,requirementsSha256:null,
    baseCommit:run.baseCommit,headCommit:run.headCommit,recordedStatus:run.status,
    summaryExcerpt:summary.slice(0,1200),summaryTruncated:summary.length>1200,
    evidenceSha256:null,assessmentSha256:null,decisionSha256:null};
  const requirements = JSON.stringify({title:task.title,purpose:task.purpose,criteria:task.criteria,revision:task.revision ?? 1});
  const records = structuredClone([run.evidence ?? null,run.codeReview ?? null,run.review ?? null]);
  // This digest matches the existing requirements contract, which hashes its fixed JSON order.
  context.requirementsSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(requirements)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  [context.evidenceSha256,context.assessmentSha256,context.decisionSha256] = await Promise.all(records.map(value => value === null ? null : sha256(value)));
  validateContext(context,context.headCommit);
  return readGitNote(serializeGitNote({format:GIT_NOTE_FORMAT,commit:context.headCommit,records:[{sha256:await sha256(context),context}]}));
}

export async function mergeGitNotes(existing, incoming) {
  const addition = await readGitNote(incoming), previous = existing === null ? null : await readGitNote(existing,addition.commit);
  const records = new Map([...(previous?.records ?? []),...addition.records].map(item=>[item.sha256,item]));
  if (records.size > MAX_GIT_NOTE_RECORDS) throw new Error('This commit already has 16 context records; archive them explicitly before adding more. Nothing was removed.');
  return readGitNote(serializeGitNote({format:GIT_NOTE_FORMAT,commit:addition.commit,records:[...records.values()]}));
}
