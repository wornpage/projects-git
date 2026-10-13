import {$, el, panel, shortSha} from '../dom.js';
import {projectContext, candidateOutcome, completedVerification} from '../../workbench-state.js';
import {mergeReportPanel, earlierReportPanel} from '../workbench-parts.js';
import {searchRetainedWork, indexedSearchResults, retainedWorkSnippet} from '../../retained-work.js';
import {publicationLabel,publicationLink} from '../publication.js';

export function createEvidenceView({
  getContext,
  parts, disclosure, currentProject, currentTask, currentRun, taskNumber,
  retainedSearches, loadIndexedSearch, rebuildSearch, render, announce, switchView,
  downloadEvidence, independentlyVerified, checksFailed, collections
}) {
  const {taskHeader, candidateNav, runStatus, timeline} = parts;
  function fact(label, value) { return el("div", { class: "fact" }, el("div", { class: "fact-label" }, label), el("div", { class: "fact-value" }, value)); }

  function retainedWorkSearch(project) {
    const {workspace} = getContext();
    if (!retainedSearches.has(project.id)) retainedSearches.set(project.id, { draft: '', query: '', limit: 10, mode: 'literal', remote: null, loading: false, error: '', request: 0 });
    const state = retainedSearches.get(project.id);
    const indexed = Boolean(workspace.capabilities?.retainedSearch);
    if (indexed && !state.remote && !state.loading && !state.error) queueMicrotask(() => {
      if (!state.loading && retainedSearches.get(project.id) === state && currentProject()?.id === project.id) void loadIndexedSearch(project, state);
    });
    const result = indexed ? { total: state.remote?.total ?? 0, items: indexedSearchResults(workspace, project.id, state.remote?.items ?? []) } : searchRetainedWork(workspace, project.id, state.query);
    const shown = indexed ? result.items : result.items.slice(0, state.limit);
    const input = el('input', { id: 'retained-query', type: 'search', maxlength: 200, value: state.draft,
      placeholder: 'Search the history below', 'aria-describedby': 'retained-search-help retained-search-scope',
      oninput: event => { state.draft = event.target.value; } });
    const search = () => {
      state.query = state.draft.trim(); state.limit = 10;
      if (indexed) { state.remote = null; void loadIndexedSearch(project, state); }
      else { render(true); announce(resultMessage()); }
    };
    const resultMessage = () => {
      const {workspace} = getContext();
      const updated = searchRetainedWork(workspace, project.id, state.query);
      return `${updated.items.length} matching history entries out of ${updated.total} in project ${project.name}.`;
    };
    return el('section', { class: 'panel retained-search', 'aria-labelledby': 'retained-heading' },
      el('div', { class: 'panel-header' }, el('h2', { id: 'retained-heading' }, 'Project history')),
      el('div', { class: 'retained-search-body' },
        el('p', { class: 'retained-project' }, el('span', {}, 'Project: '), el('strong', {}, project.name)),
        el('p', { id: 'retained-search-help', class: 'definition-note' }, 'Browse saved task briefs and candidate changes, or search their titles, summaries, changed filenames, commits and review notes.'),
        el('p', { id: 'retained-search-scope', class: 'definition-note retained-search-scope' }, 'Filenames come from recorded candidate changes. Open changes to browse their saved diffs. This search does not cover file contents or every file in the repository.'),
        el('form', { class: 'retained-search-form', role: 'search', 'aria-label': 'Retained project work', onsubmit: event => { event.preventDefault(); search(); } },
          el('div', { class: 'retained-search-field' }, el('label', { for: 'retained-query' }, 'Search project history'), input),
          indexed ? el('div', { class: 'retained-search-mode' }, el('label', { for: 'retained-mode' }, 'Search method'),
            el('select', { id: 'retained-mode', onchange: event => { state.mode = event.target.value; } },
              el('option', { value: 'literal', selected: state.mode === 'literal' }, 'Literal'),
              workspace.capabilities.semanticSearch ? el('option', { value: 'semantic', selected: state.mode === 'semantic' }, 'Semantic · embedding call') : null)) : null,
          el('button', { id: 'retained-submit', type: 'submit', class: 'button', disabled: state.loading }, state.loading ? 'Searching…' : 'Search'),
          el('button', { id: 'retained-clear', type: 'button', class: 'button', onclick: () => { state.draft = ''; state.mode = 'literal'; search(); $('#retained-query').focus(); } }, 'Clear')),
        state.error ? el('p', { class: 'checks-failed' }, state.error) : null,
        el('p', { class: 'definition-note', id: 'retained-count', role: 'status' },
          indexed ? state.loading ? 'Loading indexed history…' : !state.remote ? 'No indexed results loaded.'
            : `${shown.length} shown · ${state.remote.mode === 'semantic' ? 'up to 20 ranked results; no exhaustive match count' : state.remote.matched + ' matching'} / ${result.total} indexed records. ${state.remote.mode === 'semantic' ? 'Semantic' : 'Literal'} results${state.remote.query ? ' for “' + state.remote.query + '”' : ''}. Historical requirement and commit revisions count separately.`
            : state.query ? `${shown.length} shown · ${result.items.length} matching / ${result.total} total history entries for “${state.query}”. All search words must match.`
              : `Showing ${shown.length} of ${result.total} history ${result.total === 1 ? 'entry' : 'entries'}. Each entry is a saved candidate change or a task brief.`),
        indexed && state.remote ? el('p', { class: 'definition-note' }, state.remote.index?.error_code ? 'Index needs attention: ' + state.remote.index.error_code
            : state.remote.sourceRevision < workspace.sourceRevision ? 'The workspace changed after this search. Refresh results to check indexing progress.'
            : state.remote.index?.attempts >= 4 && state.remote.index.indexed_revision < state.remote.index.revision ? 'The automatic delivery allowance is used and indexing has not completed. Refresh its status and inspect queued or dead-letter work before rebuilding.'
            : (state.remote.index?.indexed_revision ?? -1) < (state.remote.index?.revision ?? 0) ? 'Index is catching up. Results may omit recent work.' : 'History index is current.') : null,
        shown.length ? el('ul', { class: 'retained-results' }, shown.map(({ task, run, outcome, proof, href, matchedFields, matchedRevision, matchedHead, snippet, score, historical }) =>
          el('li', {},
            el('a', { href, class: 'retained-result-link', onclick: event => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); switchView(run ? 'review' : 'work', task.id, run?.id ?? null);
            } }, task.title),
            el('p', { class: 'retained-result-kind' }, run ? 'Candidate: ' + run.label : 'Task brief · no committed candidate'),
            el('p', { class: 'retained-result-meta' }, `Task ${taskNumber(task)} · Current requirements r${task.revision ?? 1}${run ? ' · head ' + shortSha(run.headCommit) : ' · Task brief'}`),
            matchedRevision ? el('p', { class: 'retained-result-meta' }, `Matched requirements r${matchedRevision}${matchedHead ? ' · commit ' + shortSha(matchedHead) : ' · task brief'}${typeof score === 'number' ? ' · similarity ' + score.toFixed(3) + ' (not confidence)' : ''}`) : null,
            el('p', {}, outcome.label + ' · ' + proof),
            run && !historical ? el('div', { class: 'retained-record-files' },
              el('p', { class: 'retained-files-label' }, el('strong', {}, run.changedFiles?.length ? `${run.changedFiles.length} changed ${run.changedFiles.length === 1 ? 'file' : 'files'}${run.diff && run.changedFiles.length > 4 ? ' · showing 4' : ''}` : 'No changed filenames recorded')),
              run.changedFiles?.length ? el('ul', { class: 'retained-file-list', 'aria-label': 'Changed files for ' + run.label }, run.changedFiles.slice(0, run.diff ? 4 : run.changedFiles.length).map(path => el('li', {}, el('code', {}, path)))) : null,
              run.diff ? el('a', { href: href + '#candidate-changes', class: 'button button-small retained-changes-link', onclick: event => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); switchView('review', task.id, run.id, {section: 'candidate-changes'});
              } }, run.changedFiles?.length > 4 ? 'Browse all ' + run.changedFiles.length + ' files' : 'View changes') : null) : historical && run ? el('p', { class: 'retained-result-meta' }, 'This match is an earlier revision. Open the current candidate to inspect its recorded files and diff.') : null,
            el('p', { class: 'retained-result-summary' }, retainedWorkSnippet(snippet || run?.summary || task.purpose || '', state.remote?.mode === 'semantic' ? '' : state.remote?.query ?? state.query)),
            matchedFields.length ? el('p', { class: 'retained-result-meta' }, 'Matches: ' + matchedFields.join(', ')) : null)))
          : !state.loading && !state.error ? el('p', {}, result.total ? 'No matching history. Clear the search to browse available entries and their recorded filenames.' : indexed ? 'No indexed records yet. Refresh after indexing completes.' : 'No tasks have been recorded in this project yet.') : null,
        indexed && state.remote?.nextOffset !== null && state.remote?.nextOffset !== undefined ? el('button', { id: 'retained-more', class: 'button', disabled: state.loading, onclick: () => loadIndexedSearch(project, state, state.remote.nextOffset) }, 'Show next 20')
          : !indexed && result.items.length > shown.length ? el('button', { id: 'retained-more', class: 'button', onclick: () => { state.limit += 10; render(true); announce(`Showing ${Math.min(state.limit, result.items.length)} of ${result.items.length} matching records.`); } }, 'Show 10 more') : null,
        indexed ? disclosure('retained-search-guide-' + project.id, 'Search methods and record counts',
          el('p', { class: 'definition-note' }, 'Literal search matches every word. Semantic search ranks bounded text excerpts and can call embeddings; similarity is not confidence or proof. Requirement and commit revisions count as separate records. Open a result to inspect its current checks and decision.')) : null,
        indexed && state.remote ? disclosure('retained-index-' + project.id, 'Index controls',
          el('div', { class: 'definition-note' },
            el('p', {}, 'Refresh reads the latest results. Rebuild schedules a new history index; workflow records and decisions stay intact.'),
            el('button', { id: 'retained-refresh', class: 'button button-small', disabled: state.loading, onclick: search }, 'Refresh results'),
            el('button', { id: 'retained-rebuild', class: 'button button-small', disabled: state.loading || !state.remote.index, onclick: () => rebuildSearch(project, state) }, workspace.capabilities.semanticSearch ? 'Rebuild index · may call embeddings' : 'Rebuild index'))) : null));
  }


  function evidenceView() {
    const {workspace, view} = getContext();
    const task = currentTask();
    const run = currentRun();
    const evidence = run?.evidence;
    const completed = run ? completedVerification(workspace, run) : null;
    const project = currentProject(), context = project ? projectContext(workspace, project.id) : null;
    const runs = context?.runs ?? workspace.runs, events = context?.events ?? workspace.events;
    const unscopedEvents = workspace.events.filter(event => !event.projectId && !event.taskId);
    const rows=view==='history'?collections({id:'history-candidates-'+project.id,label:'History candidates',items:runs,text:run=>run.label+' '+(run.headCommit??'')+' '+workspace.tasks.find(task=>task.id===run.taskId)?.title,
      filters:[['all','All statuses'],...['assigned','running','awaiting_review','accepted','rejected','merged','failed','superseded'].map(status=>[status,status.replaceAll('_',' ')])],
      matches:(run,status)=>status==='all'||run.status===status,sorts:[['order','Original order'],['name','Candidate name'],['newest','Newest first']],sortKey:(run,sort)=>sort==='name'?run.label.toLowerCase():run.createdAt??run.finishedAt??''}):null;
    const columns = ["Candidate", "Head commit", "Latest checks", "Verification", "Decision"];
    const cell = (label, value) => el("td", { role: "cell" },
      el("span", { class: "evidence-field-label", "aria-hidden": "true" }, label),
      el("div", { class: "evidence-field-value" }, value));
    // One set of rows supplies both the desktop table and the phone cards.
    // Explicit roles preserve table semantics when CSS changes the layout.
    const table = runs.length ? el("table", { class: "evidence-table", role: "table" },
      el("caption", { class: "sr-only" }, "Every retained candidate and its evidence state"),
      el("thead", { role: "rowgroup" }, el("tr", { role: "row" }, columns.map(title => el("th", { scope: "col", role: "columnheader" }, title)))),
      el("tbody", { role: "rowgroup" }, (rows?.items??[]).map(candidate => {
        const candidateTask = workspace.tasks.find(task => task.id === candidate.taskId);
        const inspect = el("worn-button", { label: candidate.label, size: "sm", onclick: () => switchView("review", candidate.taskId, candidate.id) });
        return el("tr", { role: "row" },
          cell("Candidate", [inspect, el("p", { class: "evidence-task" }, `Task ${taskNumber(candidateTask)} · ${candidateTask.title}`)]),
          cell("Head commit", el("span", { class: "mono", title: candidate.headCommit || "No commit" }, shortSha(candidate.headCommit))),
          cell("Latest checks", el("span", { class: `mono ${checksFailed(candidate) ? "checks-failed" : ""}` }, candidate.evidence ? `${candidate.evidence.passed} / ${candidate.evidence.total}` : "No report")),
          cell("Verification", independentlyVerified(candidate) ? "Independent · exact head" : candidate.evidence ? "Unverified report" : "Pending"),
          cell("Decision", runStatus(candidate)));
      }))) : el("div", { class: "no-candidate" }, "No candidates or evidence yet. Start a task to create the first records.");
    return el('div', {},
      view!=='history' && task ? el('div', {}, taskHeader(task),
        candidateNav(task), run ? el('div', {},
          el('p', { class: 'record-outcome' }, candidateOutcome(workspace, run).label + ' · ' + candidateOutcome(workspace, run).next),
          el('div', { class: 'evidence-facts' }, fact('Full head commit', run.headCommit || 'No commit'), fact('Task base commit', run.baseCommit),
            fact(completed?.acceptance.label ?? 'Reported checks', evidence ? evidence.passed + ' / ' + evidence.total : 'No report'),
            completed ? fact('Acceptance-time verified at', completed.acceptance.verifiedAt ?? 'Not retained') : null,
            fact('Current independent verification', independentlyVerified(run) ? 'Exact head and requirements r' + (task.revision ?? 1) : 'Not current'),
            fact('Decision', run.review ? run.review.decision + ' · ' + run.review.reviewer : 'No decision recorded'),
            fact('Task merged commit', task.mergedCommit || 'Not merged'),
            run.publication?fact('GitHub publication',publicationLabel(run.publication)):null),
          run.publication?publicationLink(run.publication):null,
          run.review ? el('blockquote', { class: 'saved-draft' }, run.review.note) : null,
          mergeReportPanel(workspace, run, disclosure),
          earlierReportPanel(workspace, run, disclosure),
          evidence ? disclosure('output-' + run.id + '-' + (evidence.taskRevision ?? 1), 'Verification command and output',
            el('p', { class: 'head-hint' }, 'Command · ' + evidence.command + ' · Exit code ' + evidence.exitCode),
            el('pre', { class: 'output' }, evidence.output || 'No output retained')) : null) : null) : null,
      view==='history' ? el('div',{},
      el('section',{'aria-label':'Retained project candidates'},rows.controls,table,rows.navigation),
      disclosure('history-count-help-'+project.id,'About these records',
        el('p',{},'Checks show passed / total from each candidate’s latest report, which may be stale. Verification identifies current independent evidence. Earlier reports remain in the candidate record.')),
      project ? disclosure('history-search-'+project.id,'Search retained contents and filenames',retainedWorkSearch(project)) : null,
      disclosure('project-events-' + (project?.id ?? workspace.id), 'Complete project activity · ' + events.length + ' events', timeline(events, Infinity,'project-events-'+project.id)),
      unscopedEvents.length ? disclosure('unscoped-events', 'Workspace activity without project attribution · ' + unscopedEvents.length + (unscopedEvents.length === 1 ? ' event' : ' events'),
        el('p', { class: 'definition-note' }, 'These workspace events have no recorded project identity. Historical records are retained without guessing their project from a name.'), timeline(unscopedEvents, Infinity,'unscoped-events')) : null,
      disclosure('workspace-export', 'Export the whole workspace',
        el('p', { class: 'definition-note' }, 'This export includes every project, task and retained candidate. Download a single-task handoff from Task details. Review private content before sharing either file.'),
        el('worn-button', { label: 'Export workspace evidence JSON', size: 'sm', onclick: downloadEvidence }))) : null);
  }
  return evidenceView;
}
