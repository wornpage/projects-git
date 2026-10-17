import {$, el} from './dom.js';
import {commandEntries} from '../workbench-state.js';

// The palette navigates existing work; it never submits a workflow mutation.
export function createNavigation({getContext, dialogs, announce, selectProject, switchView, projectDiscovery, prepareOpen}) {
  let commandIndex = 0;
  let displayedCommands = [];
  let request=0,catalog=null,displayedScope=null;
  const scope=()=>JSON.stringify([getContext().workspace?.id,getContext().workspace?.authentication?.principal??null]);
  dialogs.register('command-dialog');

  async function renderCommands(offset=0) {
    const {workspace} = getContext();
    const query=$('#command-query').value,started=++request,identity=scope();
    const all = workspace ? commandEntries(workspace, query).filter(entry=>entry.group!=='Projects') : [];
    displayedCommands=[];displayedScope=identity;
    $('#command-count').textContent='Searching project names across the workspace…';
    $('#command-results').replaceChildren();
    $('#command-support').replaceChildren();
    let projects=[],failure=null;
    try {const result=await projectDiscovery.find(query,offset,{at:offset?catalog?.revision??null:null});
      if(!result||started!==request||identity!==scope()||!$('#command-dialog').open)return;
      catalog=result;
      projects=catalog.items.map(item=>({id:'project-'+item.id,group:'Projects',label:item.name,detail:item.taskCount+' tasks · '+item.candidateCount+' candidates',projectId:item.id}));
    }catch(error){if(started!==request||identity!==scope()||!$('#command-dialog').open)return;failure=error.message;catalog=null;}
    displayedCommands = [...projects,...all.slice(0,60)];
    commandIndex = Math.min(Math.max(commandIndex, 0), Math.max(0, displayedCommands.length - 1));
    $('#command-count').textContent = (catalog?`${catalog.items.length} project names shown · ${catalog.matched} matching / ${catalog.total} total projects. `:'')+`${Math.min(all.length,60)} / ${all.length} matching tasks and candidates in loaded projects.`;
    $('#command-results').replaceChildren(...displayedCommands.map((entry, index) => el('div', {
      id: 'command-result-' + entry.id, role: 'option', 'aria-selected': index === commandIndex,
      class: 'command-result' + (index === commandIndex ? ' selected' : ''),
      onclick: () => navigateCommand(entry.id),
      onpointermove: () => {
        if (commandIndex !== index) { commandIndex = index; syncCommandSelection(); }
      },
    }, el('strong', {}, entry.label), el('span', {class: 'small'}, entry.group + ' · ' + entry.detail))));
    $('#command-support').replaceChildren(...[
      failure?el('p',{class:'inline-error',role:'alert'},failure):null,
      failure?el('button',{class:'button button-small',onclick:()=>{void renderCommands();}},'Retry project search'):null,
      !displayedCommands.length?el('p', {class: 'no-command-results'}, 'No matching work. Try a project name, loaded task title, agent label or commit prefix.'):null,
      catalog?el('button',{class:'button button-small',disabled:catalog.previousOffset===null,onclick:()=>{void renderCommands(catalog.previousOffset);}},'Previous projects'):null,
      catalog?el('button',{class:'button button-small',disabled:catalog.nextOffset===null,onclick:()=>{void renderCommands(catalog.nextOffset);}},'Next projects'):null].filter(Boolean));
    syncCommandSelection();
  }

  function syncCommandSelection() {
    const results = [...$('#command-results').querySelectorAll('[role="option"]')];
    results.forEach((node, index) => {
      node.setAttribute('aria-selected', String(index === commandIndex));
      node.classList.toggle('selected', index === commandIndex);
    });
    const active = results[commandIndex];
    if (active) {
      $('#command-query').setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({block: 'nearest'});
    } else $('#command-query').removeAttribute('aria-activedescendant');
  }

  function openCommands() {
    if (!getContext().workspace) { announce('Connect to the workspace before finding work.'); return; }
    if ($('#command-dialog').open) { $('#command-dialog').close(); return; }
    const opener=prepareOpen();
    if (document.querySelector('dialog[open]')) return;
    commandIndex = 0;
    $('#command-query').value = '';
    dialogs.show('command-dialog', '#command-query',opener);
    void renderCommands();
  }

  function navigateCommand(id) {
    let entry = displayedScope===scope()&&displayedCommands.find(item=>item.id===id);
    if(entry&&entry.group!=='Projects')entry=commandEntries(getContext().workspace,$('#command-query').value).find(item=>item.id===id);
    if (!entry) { void renderCommands(); announce('That work is no longer available.'); return; }
    dialogs.skipFocusRestore('command-dialog');
    $('#command-dialog').close();
    if (entry.group === 'Projects') {
      selectProject(entry.projectId);
    } else switchView(entry.view, entry.taskId, entry.runId ?? null);
  }

  $('#open-command-palette').addEventListener('click', openCommands);
  $('#close-command-dialog').addEventListener('click', () => $('#command-dialog').close());
  $('#command-query').addEventListener('input', () => { commandIndex = 0; void renderCommands(); });
  $('#command-query').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); $('#command-dialog').close(); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      commandIndex = Math.max(0, Math.min(displayedCommands.length - 1, commandIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      syncCommandSelection();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (displayedCommands[commandIndex]) navigateCommand(displayedCommands[commandIndex].id);
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommands(); }
  });
  function leave() {
    request++;commandIndex=0;displayedCommands=[];displayedScope=null;catalog=null;
    $('#command-query').value='';$('#command-query').removeAttribute('aria-activedescendant');
    for(const id of ['command-count','command-results','command-support'])$('#'+id).replaceChildren();
  }
  return {openCommands,leave};
}
