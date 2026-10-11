import {el, shortSha} from './dom.js';
import {candidateLifecycle} from '../task-lifecycle.js';

export function taskLifecycle(workspace, run, switchView) {
  if (!run) return null;
  return el('section', {class: 'task-lifecycle', 'aria-label': 'Task path for ' + run.label},
    el('div', {class: 'lifecycle-heading'}, el('h3', {}, 'Task path'),
      el('p', {}, run.label, ' · ', el('span', {class: 'mono'}, run.headCommit ? shortSha(run.headCommit) : 'No commit yet'))),
    el('ol', {class: 'lifecycle-stages', role: 'list'}, candidateLifecycle(workspace, run).map((stage, index) => {
      const content = [el('span', {class: 'lifecycle-number', 'aria-hidden': 'true'}, index + 1),
        el('span', {class: 'lifecycle-facts'}, el('strong', {class: 'lifecycle-title'}, stage.title),
          el('span', {class: 'lifecycle-state'}, stage.label), el('span', {class: 'lifecycle-detail'}, stage.detail))];
      const view = stage.view ?? 'review';
      const href = '/?'+new URLSearchParams({view, task: run.taskId, candidate: run.id})+(stage.section ? '#'+stage.section : '');
      return el('li', {class: 'lifecycle-stage lifecycle-'+stage.tone}, stage.section || stage.view
        ? el('a', {href, id: 'lifecycle-'+stage.id+'-'+run.id, onclick: event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); switchView(view, run.taskId, run.id, stage.section ? {section: stage.section} : {});
        }}, ...content) : el('div', {}, ...content));
    })));
}
