import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionPage} from '../public/collection-page.js';
import {createCollectionPager} from '../public/ui/collection.js';
import {createReportList} from '../public/ui/report-list.js';
import {el} from '../public/ui/dom.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';
const nodes=node=>[node,...node.children.flatMap(nodes)];

test('large filtered pages retain original totals, exact identities and failed work without mutating records',()=>{
 const items=Array.from({length:1000},(_,i)=>({id:i,name:'Task '+i,status:i%3?'merged':'failed'})),before=structuredClone(items);
 const state={query:'Task',filter:'failed',sort:'name',offset:25};
 const page=collectionPage(items,state,{text:item=>item.name,matches:(item,status)=>item.status===status,sortKey:item=>item.name});
 assert.equal(page.items.length,25);assert.equal(page.total,1000);assert.equal(page.matched,334);assert.equal(page.from,26);assert.equal(page.next,50);
 assert.ok(page.items.every(item=>item.status==='failed'));assert.deepEqual(items,before);
 const none=collectionPage(items,{...state,query:'missing'});assert.equal(none.matched,0);assert.equal(none.total,1000);assert.equal(none.offset,0);
});

test('paging, filter reset and a replaced workspace scope keep all records reachable',async()=>{
 installFakeDOM();let scope='owner-a',renders=0;
 const pager=createCollectionPager({getScope:()=>scope,render:()=>renders++}),items=Array.from({length:61},(_,i)=>({id:i,name:'Candidate '+i}));
 const draw=()=>pager({id:'candidates',label:'Candidates',items,text:item=>item.name,sortKey:item=>item.name});
 let page=draw();assert.deepEqual(page.items.map(x=>x.id),Array.from({length:25},(_,i)=>i));
 await nodes(page.navigation).find(x=>x.textContent==='Next candidates').dispatch('click');page=draw();assert.equal(page.from,26);
 await nodes(page.navigation).find(x=>x.textContent==='Next candidates').dispatch('click');page=draw();assert.equal(page.from,51);assert.equal(page.to,61);
 scope='owner-b';page=draw();assert.equal(page.from,1);assert.equal(renders,2);
});

test('collapsing mobile options preserves the active filter and original denominator',async()=>{
 installFakeDOM();const items=[{id:1,name:'Ready',status:'ready'},{id:2,name:'Waiting',status:'waiting'}];
 const pager=createCollectionPager({getScope:()=> 'workspace',render(){}});
 const draw=()=>pager({id:'tasks',label:'Tasks',items,text:item=>item.name,filters:[['all','All'],['ready','Ready']],matches:(item,value)=>value==='all'||item.status===value});
 let page=draw();await page.controls.querySelector('#tasks-options-toggle').dispatch('click');page=draw();
 assert.equal(page.controls.querySelector('#tasks-options').attrs['data-expanded'],'true');
 const filter=page.controls.querySelector('#tasks-filter');filter.value='ready';await filter.dispatch('change');
 page=draw();await page.controls.querySelector('#tasks-options-toggle').dispatch('click');page=draw();
 assert.equal(page.controls.querySelector('#tasks-options').attrs['data-expanded'],'false');
 assert.match(page.controls.querySelector('#tasks-options-toggle').textContent,/active/);
 assert.equal(page.matched,1);assert.equal(page.total,2);assert.deepEqual(page.items.map(item=>item.id),[1]);
});

test('a large report history preserves exact earlier failure denominators and provenance',async()=>{
 installFakeDOM();const entries=Array.from({length:60},(_,i)=>({label:'Report '+i,report:{commit:String(i).padStart(40,'a'),taskRevision:i+1,passed:i?3:0,total:i?3:2,source:'independent-local-checks',output:i?'passed':'Retained failure',verifiedAt:'2026-10-11T00:00:00Z'}}));
 const before=structuredClone(entries),disclosure=(id,title,...body)=>el('details',{id},el('summary',{},title),...body);
 const page=createReportList({id:'reports',title:'Reports',entries,definition:'Each report retains its own counts.',disclosure});
 assert.equal(nodes(page).filter(x=>x.attrs['aria-controls']==='reports-detail').length,10);
 await nodes(page).find(x=>x.textContent==='Earlier reports'&&x.tagName==='BUTTON').dispatch('click');
 await nodes(page).find(x=>x.textContent==='Earlier reports'&&x.tagName==='BUTTON').dispatch('click');
 await nodes(page).find(x=>x.id==='reports-select-0').dispatch('click');
 const selected=page.querySelector('#reports-detail').textContent;assert.match(selected,/0 \/ 2/);assert.match(selected,/Retained failure/);assert.match(selected,/independent-local-checks/);assert.deepEqual(entries,before);
});
