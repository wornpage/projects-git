import {el} from './dom.js';

function settingsIcon() {
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  for(const [name,value] of Object.entries({class:'project-settings-icon',viewBox:'0 0 24 24',width:'20',height:'20',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(name,value);
  const path=document.createElementNS(ns,'path'),circle=document.createElementNS(ns,'circle');
  const points=Array.from({length:32},(_,i)=>{const angle=i*Math.PI/16,radius=[8,10,10,8][i%4];return (12+Math.cos(angle)*radius).toFixed(3)+','+(12+Math.sin(angle)*radius).toFixed(3);});
  path.setAttribute('d','M'+points.join('L')+'Z');
  for(const [name,value] of Object.entries({cx:'12',cy:'12',r:'3'}))circle.setAttribute(name,value);
  svg.append(path,circle);return svg;
}

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
    'aria-label':'Project settings',title:'Project settings','aria-controls':'inspector-dialog', 'aria-haspopup':'dialog', onclick: () => {
      if (!trigger.isConnected) return;
      onOpen(panel,trigger);
    }}, settingsIcon(),el('span',{class:'project-settings-label'},'Project settings'));
  return {trigger, panel};
}
