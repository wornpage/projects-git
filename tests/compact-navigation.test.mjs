import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createCompactNavigation} from '../public/ui/compact-navigation.js';
import {createDialogManager} from '../public/ui/dialogs.js';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const openInspectorSource=app.slice(app.indexOf('function openInspector('),app.indexOf('\nfunction actionNotice('));
const openTaskComposerSource=app.slice(app.indexOf('function openTaskComposer('),app.indexOf('\nfunction openAgentConnection('));

function fixture() {
  let document;
  const queuedCloses=[];
  class Node {
    constructor(id=''){this.id=id;this.children=[];this.events={};this.attrs={};this.open=false;}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    dispatch(name){for(const fn of this.events[name]??[])fn({});}
    setAttribute(name,value){this.attrs[name]=value;}
    remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}
    append(...nodes){for(const node of nodes){node.remove();this.children.push(node);node.parent=this;}}
    before(node){const parent=this.parent;node.remove();parent.children.splice(parent.children.indexOf(this),0,node);node.parent=parent;}
    after(node){const parent=this.parent;node.remove();parent.children.splice(parent.children.indexOf(this)+1,0,node);node.parent=parent;}
    replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
    get isConnected(){for(let node=this;node;node=node.parent)if(node===root)return true;return false;}
    focus(){document.activeElement=this;}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;queuedCloses.push(()=>this.dispatch('close'));}
  }
  const ids=['open-workspace-navigation','workspace-home','project-views','task-count','project-navigation','new-project','open-installation','workspace-topbar','workspace-utilities','inspector-dialog','inspector-title','inspector-content','close-inspector','task-launcher','new-task-summary'];
  const nodes=Object.fromEntries(ids.map(id=>[id,new Node(id)]));
  const root=new Node(),sidebar=new Node(),panel=nodes['inspector-content'];
  root.append(sidebar,nodes['inspector-dialog']);
  root.append(nodes['workspace-topbar']);nodes['workspace-topbar'].append(nodes['workspace-utilities']);
  root.append(nodes['task-launcher']);nodes['task-launcher'].append(nodes['new-task-summary']);
  sidebar.append(nodes['workspace-home'],nodes['project-navigation'],nodes['new-project'],nodes['open-installation'],nodes['open-workspace-navigation']);
  nodes['project-navigation'].append(nodes['project-views']);nodes['project-views'].append(nodes['task-count']);
  nodes['inspector-dialog'].append(nodes['inspector-title'],nodes['close-inspector'],panel);
  const find=(parent,id)=>parent.id===id?parent:parent.children.map(child=>find(child,id)).find(Boolean)??null;
  const state={workspace:{id:'one'},restores:0};
  document={activeElement:nodes['open-workspace-navigation'],getElementById:id=>find(root,id),
    querySelector:selector=>selector==='dialog[open]'?(nodes['inspector-dialog'].open?nodes['inspector-dialog']:null):find(root,selector.slice(1)),
    createElement:()=>new Node()};
  const dialogs=createDialogManager(document);dialogs.register('inspector-dialog');
  const context={document,$:selector=>document.querySelector(selector),dialogs};
  const openInspector=runInNewContext(openInspectorSource+'\nopenInspector',context);
  const controller=createCompactNavigation({document,getWorkspace:()=>state.workspace,openInspector,onRestore(){
    state.restores++;
    // Production refresh queries the connected document before placing this nav.
    const views=document.getElementById('project-views');assert.ok(views,'project views must be connected before refresh');
    assert.ok(document.getElementById('task-count'),'full counters remain connected');
    nodes['project-navigation'].append(views);
  }});
  context.compactNavigation=controller;
  const flushClose=async()=>{await new Promise(resolve=>setImmediate(resolve));for(const close of queuedCloses.splice(0))close();};
  return {nodes,sidebar,panel,state,controller,document,openInspector,flushClose,Node,context,dialogs};
}

test('phone navigation reuses live counters and handlers and restores the same nodes after native close',async()=>{
  const f=fixture(),views=f.nodes['project-views'],home=f.nodes['workspace-home'];
  views.fullTasks=120;views.fullCandidates=320;let clicks=0;views.addEventListener('click',()=>clicks++);
  f.nodes['open-workspace-navigation'].dispatch('click');assert.equal(f.controller.isOpen(),true);
  assert.equal(f.panel.children[0].children[0],home);assert.equal(f.panel.children[0].children[1],views);
  assert.equal(f.panel.children[0].children[2],f.nodes['new-project']);
  assert.equal(f.panel.children[0].children[3],f.nodes['open-installation']);
  assert.equal(f.panel.children[0].children[4],f.nodes['workspace-utilities']);
  views.fullCandidates=321;views.dispatch('click');assert.equal(clicks,1);
  f.nodes['inspector-dialog'].close();assert.equal(f.controller.isOpen(),true,'native close dispatches asynchronously');
  await f.flushClose();assert.equal(f.controller.isOpen(),false);assert.equal(f.state.restores,1);
  assert.equal(f.sidebar.children[0],home);assert.equal(f.nodes['project-navigation'].children[0],views);
  assert.equal(f.nodes['new-project'].parent,f.sidebar);
  assert.equal(f.nodes['open-installation'].parent,f.sidebar);
  assert.equal(f.nodes['workspace-utilities'].parent,f.nodes['workspace-topbar']);
  assert.equal(views.fullTasks,120);assert.equal(views.fullCandidates,321);views.dispatch('click');assert.equal(clicks,2);
});

test('phone navigation never detaches nodes before data loads or through another modal',()=>{
  const f=fixture(),before=[...f.sidebar.children];f.state.workspace=null;
  f.nodes['open-workspace-navigation'].dispatch('click');assert.equal(f.controller.isOpen(),false);assert.deepEqual(f.sidebar.children,before);
  f.state.workspace={id:'one'};f.nodes['inspector-dialog'].showModal();f.nodes['open-workspace-navigation'].dispatch('click');
  assert.equal(f.controller.isOpen(),false);assert.deepEqual(f.sidebar.children,before);
});

test('New project closes navigation before the composer and returns focus to Navigate',async()=>{
  const f=fixture();f.dialogs.register('task-launcher');
  Object.assign(f.context,{workspace:f.state.workspace,taskCreation:{locked:false,activate:source=>source==='repository'},updateChrome(){}});
  const openTaskComposer=runInNewContext(openTaskComposerSource+'\nopenTaskComposer',f.context);
  f.nodes['open-workspace-navigation'].dispatch('click');f.nodes['new-project'].focus();
  openTaskComposer('repository');
  assert.equal(f.nodes['inspector-dialog'].open,false);assert.equal(f.controller.isOpen(),false);
  assert.equal(f.nodes['new-project'].parent,f.sidebar);assert.equal(f.nodes['task-launcher'].open,true);
  await f.flushClose();
  assert.equal(f.document.activeElement,f.nodes['new-task-summary']);
  f.nodes['task-launcher'].close();await f.flushClose();
  assert.equal(f.document.activeElement,f.nodes['open-workspace-navigation']);
});

test('actual inspector replacement restores both navigation nodes before discarding its body',async()=>{
  const f=fixture(),views=f.nodes['project-views'],home=f.nodes['workspace-home'];
  let clicks=0;views.fullCandidates=320;views.addEventListener('click',()=>clicks++);
  f.nodes['open-workspace-navigation'].dispatch('click');
  const replacement=new f.Node('replacement');f.openInspector('Project settings',replacement);
  assert.equal(f.controller.isOpen(),false);assert.equal(f.state.restores,1);
  assert.equal(f.document.getElementById('workspace-home'),home);assert.equal(f.document.getElementById('project-views'),views);
  assert.equal(f.panel.children[0],replacement);assert.equal(f.nodes['inspector-dialog'].open,true);
  assert.equal(f.document.activeElement,f.nodes['close-inspector']);
  await f.flushClose();assert.equal(f.state.restores,1);assert.equal(views.fullCandidates,320);
  views.dispatch('click');assert.equal(clicks,1);
  f.nodes['inspector-dialog'].close();await f.flushClose();
  f.nodes['open-workspace-navigation'].dispatch('click');assert.equal(f.panel.children[0].children[1],views);
});

test('queued close cannot remove replacement content or consume its focus restoration',async()=>{
  const f=fixture();f.nodes['open-workspace-navigation'].dispatch('click');
  f.nodes['inspector-dialog'].close();
  const opener=new f.Node('open-progress');f.sidebar.append(opener);opener.focus();
  const replacement=new f.Node('replacement');f.openInspector('Task progress',replacement);
  assert.equal(f.state.restores,1);assert.equal(f.document.getElementById('project-views'),f.nodes['project-views']);
  await f.flushClose();assert.equal(f.nodes['inspector-dialog'].open,true);assert.equal(f.panel.children[0],replacement);
  assert.equal(f.document.activeElement,f.nodes['close-inspector']);assert.equal(f.state.restores,1);
  f.nodes['inspector-dialog'].close();await f.flushClose();
  assert.equal(f.document.activeElement,opener);
});

test('queued close from the old drawer cannot remove a freshly reopened navigation menu',async()=>{
  const f=fixture();f.nodes['open-workspace-navigation'].dispatch('click');
  f.nodes['inspector-dialog'].close();f.nodes['open-workspace-navigation'].dispatch('click');
  assert.equal(f.controller.isOpen(),true);assert.equal(f.state.restores,1);
  await f.flushClose();assert.equal(f.controller.isOpen(),true);assert.equal(f.state.restores,1);
  assert.equal(f.panel.children[0].children[0],f.nodes['workspace-home']);assert.equal(f.panel.children[0].children[1],f.nodes['project-views']);
  f.nodes['inspector-dialog'].close();await f.flushClose();assert.equal(f.state.restores,2);
});
