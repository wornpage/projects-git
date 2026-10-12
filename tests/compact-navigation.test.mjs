import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompactNavigation} from '../public/ui/compact-navigation.js';

function fixture() {
  class Node {
    constructor(id=''){this.id=id;this.children=[];this.events={};this.attrs={};}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    dispatch(name){for(const fn of this.events[name]??[])fn();}
    setAttribute(name,value){this.attrs[name]=value;}
    append(...nodes){for(const node of nodes){if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);this.children.push(node);node.parent=this;}}
    before(node){const parent=this.parent;if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);parent.children.splice(parent.children.indexOf(this),0,node);node.parent=parent;}
  }
  const nodes=Object.fromEntries(['open-workspace-navigation','workspace-home','project-views','project-navigation','inspector-dialog'].map(id=>[id,new Node(id)]));
  const sidebar=new Node(),panel=new Node();sidebar.append(nodes['workspace-home'],nodes['project-navigation']);nodes['project-navigation'].append(nodes['project-views']);
  const state={workspace:{id:'one'},modal:false,restores:0,opens:0};
  const document={getElementById:id=>nodes[id],querySelector:()=>state.modal?nodes['inspector-dialog']:null,createElement:()=>new Node()};
  const controller=createCompactNavigation({document,getWorkspace:()=>state.workspace,openInspector(title,body){assert.equal(title,'Navigate');state.opens++;panel.append(body);state.modal=true;},onRestore(){state.restores++;nodes['project-navigation'].append(nodes['project-views']);}});
  return {nodes,sidebar,panel,state,controller};
}

test('phone navigation reuses live counters and handlers and restores the same nodes',()=>{
  const f=fixture(),views=f.nodes['project-views'],home=f.nodes['workspace-home'];
  views.fullTasks=120;views.fullCandidates=320;let clicks=0;views.addEventListener('click',()=>clicks++);
  f.nodes['open-workspace-navigation'].dispatch('click');assert.equal(f.controller.isOpen(),true);
  assert.equal(f.panel.children[0].children[0],home);assert.equal(f.panel.children[0].children[1],views);
  views.fullCandidates=321;views.dispatch('click');assert.equal(clicks,1);
  f.nodes['inspector-dialog'].dispatch('close');assert.equal(f.controller.isOpen(),false);assert.equal(f.state.restores,1);
  assert.equal(f.sidebar.children[0],home);assert.equal(f.nodes['project-navigation'].children[0],views);
  assert.equal(views.fullTasks,120);assert.equal(views.fullCandidates,321);views.dispatch('click');assert.equal(clicks,2);
});

test('phone navigation never detaches nodes before data loads or through another modal',()=>{
  const f=fixture(),before=[...f.sidebar.children];f.state.workspace=null;
  f.nodes['open-workspace-navigation'].dispatch('click');assert.equal(f.state.opens,0);assert.deepEqual(f.sidebar.children,before);
  f.state.workspace={id:'one'};f.state.modal=true;f.nodes['open-workspace-navigation'].dispatch('click');
  assert.equal(f.state.opens,0);assert.equal(f.controller.isOpen(),false);assert.deepEqual(f.sidebar.children,before);
});
