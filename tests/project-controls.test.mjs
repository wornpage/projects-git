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
  let selected=project;
  const picker=runInNewContext(pickerSource+'\nprojectPicker',{workspace,el,currentProject:()=>selected,
    projectDiscovery:{items:()=>Object.values(workspace.projects)},taskCreation:{starting:false},openTaskComposer:source=>calls.push(source),
    selectProject:id=>calls.push(id),switchView:view=>calls.push(view)});
  const options=node=>[...node.children].flatMap(child=>child.tagName==='OPTGROUP'?child.children:[child]);
  assert.match(options(picker().querySelector('select'))[0].textContent,/All projects \(1\)/);
  workspace.page.totalProjects=3;
  const select=picker().querySelector('select');
  assert.deepEqual(options(select).map(option=>option.value),['all','one','new']);
  assert.match(options(select)[0].textContent,/All projects \(3\)/);
  select.value='all';await select.dispatch('change');assert.deepEqual(calls,['projects']);
  delete workspace.page;workspace.projects.two={id:'two',name:'Second'};
  const allProjects=picker().querySelector('select');
  assert.deepEqual(options(allProjects).map(option=>option.value),['all','one','two','new']);
  allProjects.value='two';await allProjects.dispatch('change');assert.deepEqual(calls,['projects','two']);
  selected=null;
  const home=picker().querySelector('select');home.value='new';await home.dispatch('change');
  assert.equal(home.value,'all');assert.equal(calls.at(-1),'repository');
  workspace.authentication={permissions:{manage:false}};
  assert.ok(!options(picker().querySelector('select')).some(option=>option.value==='new'));
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
