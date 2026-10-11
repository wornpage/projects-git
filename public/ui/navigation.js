import {$, el} from './dom.js';
import {commandEntries} from '../workbench-state.js';

// The palette navigates existing work; it never submits a workflow mutation.
export function createNavigation({getContext, dialogs, announce, selectProject, switchView, openTaskComposer}) {
  let commandIndex = 0;
  let displayedCommands = [];
  dialogs.register('command-dialog');

  function renderCommands() {
    const {workspace} = getContext();
    const all = workspace ? commandEntries(workspace, $('#command-query').value) : [];
    displayedCommands = all.slice(0, 80);
    commandIndex = Math.min(Math.max(commandIndex, 0), Math.max(0, displayedCommands.length - 1));
    $('#command-count').textContent = `${displayedCommands.length} / ${all.length} matches · ${workspace?.page?'loaded projects; open Projects to browse all '+workspace.page.totalProjects:'projects, tasks and retained candidates across this workspace'}`;
    $('#command-results').replaceChildren(...displayedCommands.map((entry, index) => el('div', {
      id: 'command-result-' + entry.id, role: 'option', 'aria-selected': index === commandIndex,
      class: 'command-result' + (index === commandIndex ? ' selected' : ''),
      onclick: () => navigateCommand(entry.id),
      onpointermove: () => {
        if (commandIndex !== index) { commandIndex = index; syncCommandSelection(); }
      },
    }, el('strong', {}, entry.label), el('span', {class: 'small'}, entry.group + ' · ' + entry.detail))));
    if (!displayedCommands.length) $('#command-results').append(el('p', {class: 'no-command-results'}, 'No matching work. Try a project, task title, agent label or commit prefix.'));
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
    if (document.querySelector('dialog[open]')) return;
    commandIndex = 0;
    $('#command-query').value = '';
    renderCommands();
    dialogs.show('command-dialog', '#command-query');
  }

  function navigateCommand(id) {
    const {workspace} = getContext();
    const entry = workspace && commandEntries(workspace, $('#command-query').value).find(item => item.id === id);
    if (!entry) { renderCommands(); announce('That work is no longer available.'); return; }
    dialogs.skipFocusRestore('command-dialog');
    $('#command-dialog').close();
    if (entry.group === 'Projects') {
      selectProject(entry.projectId);
    } else switchView(entry.view, entry.taskId, entry.runId ?? null);
  }

  $('#open-command-palette').addEventListener('click', openCommands);
  $('#close-command-dialog').addEventListener('click', () => $('#command-dialog').close());
  $('#command-query').addEventListener('input', () => { commandIndex = 0; renderCommands(); });
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
  return {openCommands};
}
