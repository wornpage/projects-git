import {el} from './dom.js';

export function automaticMergeControls({project, hosted, canManage, busy, onChange}) {
  if (!hosted) return null;
  const enabled = project.automaticMergePolicy?.enabled === true;
  return el('section', {class:'automatic-merge-settings', 'aria-label':'Automatic approval and merge'},
    el('button', {id:'shell-automatic-merge', type:'button', class:'project-switch', role:'switch', 'aria-checked':enabled,
      disabled:busy || !canManage || project.codeConnected === false,
      'aria-describedby':'automatic-merge-explanation', onclick:() => onChange(!enabled, project.automaticMergePolicy?.version ?? 0)},
      el('span', {class:'switch-track', 'aria-hidden':true}, el('span')), 'Automatically approve and merge', el('strong', {}, enabled ? 'On' : 'Off')),
    el('p', {id:'automatic-merge-explanation', class:'small'}, 'Applies to eligible changes in this project, including changes already waiting. Requires current checks and independent review. Competing candidates and overlapping changes wait for your decision. Decisions are recorded as policy automation.'),
    el('p', {class:'small'}, 'Turning this off stops new automatic pushes. An update already sent to Git may need reconciliation.'));
}

// The stable header trigger opens the existing native inspector drawer.
export function createProjectControls({id, onOpen}, ...body) {
  const panel = el('section', {id, class: 'project-controls-panel', 'aria-labelledby': 'shell-project-controls'}, ...body);
  const trigger = el('button', {id: 'shell-project-controls', type: 'button', class: 'button button-small',
    'aria-controls':'inspector-dialog', 'aria-haspopup':'dialog', onclick: () => {
      if (!trigger.isConnected) return;
      onOpen(panel,trigger);
    }}, 'Project settings');
  return {trigger, panel};
}
