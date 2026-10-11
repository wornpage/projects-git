import {el, panel} from './dom.js';

// Each report keeps its own denominator and provenance; selection is local to this list.
export function createReportList({id, title, entries, definition, disclosure}) {
  if (!entries.length) return null;
  let selected = entries.length - 1;
  const detail = el('section', {class:'selected-report', id:id+'-detail', 'aria-label':entries.length > 1 ? 'Selected report' : 'Report details'});
  const buttons = entries.length > 1 ? entries.map((entry,index) => el('button', {
    id:id+'-select-'+index, type:'button', class:'report-row', 'aria-controls':detail.id,
    'aria-pressed':index===selected, onclick:()=>{selected=index;draw();}
  }, el('strong',{},entry.label),
    el('span',{class:'report-row-count'}, (entry.report?.passed ?? 'Not retained')+' / '+(entry.report?.total ?? 'Not retained')+' checks'),
    el('span',{class:'small'},entry.report?.verifiedAt ?? 'Timestamp not retained'),
    !entry.report || typeof entry.report!=='object' ? el('span',{class:'inline-error'},'Malformed data · inspect the workspace export') : null)) : [];
  function draw() {
    buttons.forEach((button,index)=>button.setAttribute('aria-pressed',String(index===selected)));
    const {report,label}=entries[selected];
    if (!report || typeof report!=='object') {
      detail.replaceChildren(el('p',{class:'inline-error'},'Historical report '+(selected+1)+' has malformed data. Inspect the workspace export.'));
      return;
    }
    detail.replaceChildren(...[el('h3',{},label),
      el('p',{class:'report-result'},(report.passed ?? 'Not retained')+' / '+(report.total ?? 'Not retained')+' reported checks'),
      el('dl',{class:'report-facts'},
        ...[['Commit',report.commit],['Requirements',report.taskRevision===undefined?undefined:'r'+report.taskRevision],
          ['Verified at',report.verifiedAt],['Source',report.source],['Recorded exit code',report.exitCode],
          ...(report.attemptId ? [['Merge attempt',report.attemptId]] : [])]
          .map(([name,value])=>el('div',{},el('dt',{},name),el('dd',{},value ?? 'Not retained')))),
      disclosure(id+'-output-'+selected,'Raw command and output',
        el('pre',{class:'output'},'Command · '+(report.command ?? 'Not retained')+'\n'+(report.output ?? 'No output retained'))),
      report.verification ? disclosure(id+'-provenance-'+selected,'Verifier and runtime provenance',
        el('pre',{class:'output'},JSON.stringify(report.verification,null,2))) : null].filter(node=>node!==null));
  }
  draw();
  return panel(title,el('div',{class:'panel-body report-browser'},el('p',{class:'definition-note'},definition),
    buttons.length ? el('div',{class:'report-list','aria-label':'Retained reports'},buttons) : null,detail));
}
