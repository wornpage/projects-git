import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createProjectControls} from '../public/ui/project-controls.js';
import {el} from '../public/ui/dom.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

test('project switching uses the full workspace count, including unloaded projects',async()=>{
  installFakeDOM();
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const pickerSource=source.slice(source.indexOf('function projectPicker('),source.indexOf('\nfunction updateProjectNavigation('));
  const project={id:'one',name:'First'},workspace={projects:{one:project},page:{totalProjects:1}};
  const calls=[];
  const picker=runInNewContext(pickerSource+'\nprojectPicker',{workspace,el,currentProject:()=>project,
    tasksInProject:()=>[],selectProject:id=>calls.push(id),switchView:view=>calls.push(view)});
  assert.equal(picker(),null);
  workspace.page.totalProjects=3;
  const select=picker().querySelector('select');
  assert.deepEqual(select.options.map(option=>option.value),['one','all']);
  assert.match(select.options[1].textContent,/Browse all 3 projects/);
  select.value='all';await select.dispatch('change');assert.deepEqual(calls,['projects']);
  delete workspace.page;workspace.projects.two={id:'two',name:'Second'};
  const allProjects=picker().querySelector('select');
  assert.deepEqual(allProjects.options.map(option=>option.value),['one','two']);
  allProjects.value='two';await allProjects.dispatch('change');assert.deepEqual(calls,['projects','two']);
});

test('project settings retain the header trigger and send labeled content to the native drawer',async()=>{
  const {document}=installFakeDOM(),opened=[];
  const {trigger,panel}=createProjectControls({id:'project-controls-one',onOpen:(body,opener)=>opened.push({body,opener})},el('button',{},'Connect agent'));
  assert.equal(trigger.attrs['aria-haspopup'],'dialog');assert.equal(trigger.attrs['aria-controls'],'inspector-dialog');
  trigger.focus();await trigger.dispatch('click');
  assert.equal(opened[0].body,panel);assert.equal(opened[0].opener,trigger);
  assert.equal(document.activeElement,trigger);assert.match(panel.textContent,/Connect agent/);
  assert.equal(trigger.attrs['aria-expanded'],undefined,'There is no inline expansion');
  trigger.isConnected=false;await trigger.dispatch('click');assert.equal(opened.length,1);
});

test('each project drawer receives only its own current controls',async()=>{
  installFakeDOM();const opened=[];
  const one=createProjectControls({id:'one',onOpen:body=>opened.push(body)},el('p',{},'First project'));
  const two=createProjectControls({id:'two',onOpen:body=>opened.push(body)},el('p',{},'Second project'));
  await one.trigger.dispatch('click');await two.trigger.dispatch('click');
  assert.match(opened[0].textContent,/First project/);assert.ok(!opened[0].textContent.includes('Second project'));
  assert.match(opened[1].textContent,/Second project/);
});
