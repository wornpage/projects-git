import {el, panel, captureFocus, restoreFocus} from './dom.js';
import {collectionPage} from '../collection-page.js';

// Each report keeps its own denominator and provenance; selection is local to this list.
export function createReportList({id, title, entries, definition, disclosure}) {
  if (!entries.length) return null;
  let selected = entries.length - 1;
  let offset=Math.max(0,Math.ceil(entries.length/25)-1)*25;
  const detail = el('section', {class:'selected-report', id:id+'-detail', 'aria-label':entries.length > 1 ? 'Selected report' : 'Report details'});
  const list=el('div',{class:'report-list','aria-label':'Retained reports'}),navigation=el('div',{class:'collection-page-controls'});
  let buttons=[];
  function drawRows(){
    const page=collectionPage(entries,{query:'',filter:'all',sort:'order',offset},{pageSize:25});offset=page.offset;
    buttons = entries.length > 1 ? page.items.map((entry,index) => el('button', {
    id:id+'-select-'+(index+offset), type:'button', class:'report-row', 'aria-controls':detail.id,
    'aria-pressed':index+offset===selected, onclick:()=>{selected=index+offset;draw();}
  }, el('strong',{},entry.label),
    el('span',{class:'report-row-count'}, (entry.report?.passed ?? 'Not retained')+' / '+(entry.report?.total ?? 'Not retained')+' checks'),
    el('span',{class:'small'},entry.report?.verifiedAt ?? 'Timestamp not retained'),
    !entry.report || typeof entry.report!=='object' ? el('span',{class:'inline-error'},'Malformed data · inspect the workspace export') : null)) : [];
    list.replaceChildren(...buttons);
    navigation.replaceChildren(el('p',{id:id+'-page-status',role:'status',tabindex:'-1'},`Showing ${page.from}–${page.to} of ${page.total} retained reports`),
      el('button',{id:id+'-earlier','data-focus-fallback':id+'-page-status',class:'button button-small',disabled:page.previous===null,onclick:()=>pageReports(page.previous)},'Earlier reports'),
      el('button',{id:id+'-later','data-focus-fallback':id+'-page-status',class:'button button-small',disabled:page.next===null,onclick:()=>pageReports(page.next)},'Later reports'));
  }
  function pageReports(nextOffset) {
    const focus = captureFocus(navigation);
    offset = nextOffset; drawRows(); restoreFocus(focus);
  }
  function draw() {
    buttons.forEach((button,index)=>button.setAttribute('aria-pressed',String(index+offset===selected)));
    const {report,label}=entries[selected];
    if (!report || typeof report!=='object') {
      detail.replaceChildren(el('p',{class:'inline-error'},'Historical report '+(selected+1)+' has malformed data. Inspect the workspace export.'));
      return;
    }
    detail.replaceChildren(...[el('h3',{},label),el('p',{class:'small'},'Report '+(selected+1)+' of '+entries.length),
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
  drawRows();draw();
  return panel(title,el('div',{class:'panel-body report-browser'},
    entries.length>25?navigation:null,entries.length>1?list:null,detail,
    disclosure(id+'-scope','About these reports',el('p',{},definition))));
}
