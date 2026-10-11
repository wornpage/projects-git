import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectDiscovery} from '../public/ui/project-discovery.js';
import {parseProjectCatalog,projectCatalog} from '../public/project-catalog.js';
const storage=()=>{const data=new Map();return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
function fixture(){const workspace={id:'owner-a',version:1,authentication:{principal:{id:'a',kind:'owner'}},projects:{},tasks:[],runs:[]};for(let i=0;i<20;i++)workspace.projects['p'+i]={id:'p'+i,name:'Project '+i};return workspace;}

test('recent and pinned shortcuts stay bounded and persist only IDs in their owner scope',async()=>{
 let workspace=fixture();const local=storage(),notices=[];
 const scope=()=>JSON.stringify([workspace.id,workspace.authentication.principal]);
 const discovery=createProjectDiscovery({getContext:()=>({workspace}),api:async path=>projectCatalog(workspace,parseProjectCatalog(path.split('?')[1])),storage:local,onChange:()=>notices.push(1),captureSession:()=>{const before=scope();return()=>before===scope();}});
 for(let i=0;i<20;i++)await discovery.sync('p'+i);assert.equal(discovery.items().length,8);
 for(let i=0;i<4;i++)discovery.togglePin('p'+i);discovery.togglePin('p4');assert.match(discovery.error(),/up to four/);
 assert.ok([...local.data.values()].every(text=>!text.includes('Project ')));
 workspace={...fixture(),id:'owner-b',authentication:{principal:{id:'b',kind:'owner'}}};await discovery.sync();assert.equal(discovery.items().length,0);
});

test('late project catalog responses cannot publish into a replacement identity',async()=>{
 let workspace=fixture(),resolve;const first=workspace,scope=()=>JSON.stringify([workspace.id,workspace.authentication.principal]);
 const discovery=createProjectDiscovery({getContext:()=>({workspace}),api:()=>new Promise(done=>resolve=done),storage:storage(),onChange(){},captureSession:()=>{const before=scope();return()=>before===scope();}});
 const pending=discovery.sync('p1');workspace={...fixture(),id:'other',authentication:{principal:{id:'other',kind:'owner'}}};await discovery.sync();
 resolve(projectCatalog(first,parseProjectCatalog('ids=p1')));await pending;assert.equal(discovery.items().length,0);
});

test('a renewed token for the same owner keeps their saved project pins',async()=>{
 const workspace=fixture(),local=storage();workspace.authentication.principal.issuedAt=100;
 const make=()=>createProjectDiscovery({getContext:()=>({workspace}),api:async path=>projectCatalog(workspace,parseProjectCatalog(path.split('?')[1])),storage:local,onChange(){},captureSession:()=>()=>true});
 let discovery=make();await discovery.sync('p3');discovery.togglePin('p3');
 workspace.authentication.principal.issuedAt=200;discovery=make();await discovery.sync();assert.equal(discovery.pinned('p3'),true);
});

test('invalid catalogs and unreadable shortcut storage fail explicitly without overwriting retained preferences',async()=>{
 const workspace=fixture(),local=storage(),key='projects-git-project-shortcuts-v1:'+JSON.stringify([workspace.id,'owner','a']);
 const retained='{"pinned":["p1"],"recent":"damaged"}';local.setItem(key,retained);
 const discovery=createProjectDiscovery({getContext:()=>({workspace}),api:async path=>({...projectCatalog(workspace,parseProjectCatalog(path.split('?')[1])),workspaceId:'foreign'}),storage:local,onChange(){},captureSession:()=>()=>true});
 await discovery.sync('p2');assert.equal(discovery.needsReset(),true);assert.match(discovery.error(),/unreadable/);assert.equal(local.getItem(key),retained);
 await assert.rejects(discovery.find('Project'),/invalid workspace catalog/);assert.equal(discovery.items().length,0);
});

test('a failed catalog read can retry without clearing project pins',async()=>{
 const workspace=fixture(),local=storage();let unavailable=false;
 const discovery=createProjectDiscovery({getContext:()=>({workspace,selectedProject:'p3'}),api:async path=>{if(unavailable)throw Error('Project catalog is unavailable');return projectCatalog(workspace,parseProjectCatalog(path.split('?')[1]));},storage:local,onChange(){},captureSession:()=>()=>true});
 await discovery.sync('p3');discovery.togglePin('p3');await new Promise(resolve=>setImmediate(resolve));
 unavailable=true;workspace.version++;await discovery.sync('p3');assert.match(discovery.error(),/unavailable/);assert.equal(discovery.pinned('p3'),true);
 unavailable=false;discovery.retry();await new Promise(resolve=>setImmediate(resolve));assert.equal(discovery.error(),'');assert.equal(discovery.pinned('p3'),true);assert.equal(discovery.items()[0].id,'p3');
});
