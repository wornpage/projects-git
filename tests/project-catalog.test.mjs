import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProjectCatalog,projectCatalog} from '../public/project-catalog.js';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {initialSnapshot,HostedController} from '../src/cloudflare/controller.ts';
import {sqliteStorage} from './helpers/sqlite-store.mjs';
import {testAuthority,testReviewerAuthority} from './helpers/hosted-authority.mjs';
import {authorizeRoute} from '../src/cloudflare/access.ts';

function fixture(){
 const state=initialSnapshot('test'),workspace=state.workspace;
 for(let p=1;p<=100;p++){
  const id='project-'+String(p).padStart(3,'0');workspace.projects[id]={id,name:'Project '+String(p).padStart(3,'0'),mainCommit:'a'.repeat(40)};
  for(let t=0;t<5;t++){const taskId=id+'-task-'+t;workspace.tasks.push({id:taskId,projectId:id,title:'Private task '+t,criteria:['Private requirement']});
   for(let r=0;r<3;r++)workspace.runs.push({id:taskId+'-'+r,taskId,label:'Private candidate',diff:'Private committed source',evidence:{output:'Private check output'}});}
 }
 workspace.projects['unicode']={id:'unicode',name:'Örder management',mainCommit:'b'.repeat(40)};
 return state;
}

test('project name search crosses directory pages and exposes only metadata with full counts',()=>{
 const state=fixture(),before=structuredClone(state);
 const result=projectCatalog(state.workspace,parseProjectCatalog('q=Project+099'));
 assert.equal(result.total,101);assert.equal(result.matched,1);assert.deepEqual(result.items,[{id:'project-099',name:'Project 099',taskCount:5,candidateCount:15}]);
 assert.ok(!JSON.stringify(result).includes('Private'));assert.equal(projectCatalog(state.workspace,parseProjectCatalog('q=örder')).matched,1);assert.deepEqual(state,before);
 for(const q of ['limit=0','limit=51','q='+('x'.repeat(201)),'q=x&q=y','ids=a,a','ids=a,b&limit=1','ids=a&q=x','workspace=foreign'])assert.throws(()=>parseProjectCatalog(q),{code:'INVALID_PROJECT_CATALOG'});
 assert.throws(()=>projectCatalog(state.workspace,parseProjectCatalog('offset=120')),{code:'PROJECT_CATALOG_PAGE_UNAVAILABLE'});
 const first=projectCatalog(state.workspace,parseProjectCatalog('limit=20'));
 const next=projectCatalog(state.workspace,parseProjectCatalog('limit=20&offset=20&at='+first.revision));
 assert.equal(next.offset,20);assert.equal(next.total,101);assert.ok(next.items.every(item=>!first.items.some(previous=>previous.id===item.id)));
});

test('canonical SQLite catalog uses no full snapshot read or writes and rejects stale paging',()=>{
 const {db,storage}=sqliteStorage(),state=fixture();
 const store=new WorkspaceStore(storage,state.workspace.id);state.revision=1;store.write(state,0);
 store.read=()=>{throw Error('A metadata read must not assemble a full snapshot.');};
 const before=db.prepare('SELECT revision,data FROM workspace_header').all(),rows=db.prepare('SELECT count(*) AS n FROM workspace_records').get().n;
 const result=store.readCatalog(parseProjectCatalog('q=Project+099'));assert.equal(result.items[0].candidateCount,15);assert.equal(result.total,101);
 assert.throws(()=>store.readCatalog(parseProjectCatalog('at=0&offset=20')),{code:'PROJECT_CATALOG_CHANGED'});
 assert.throws(()=>store.readCatalog(parseProjectCatalog('offset=120')),error=>error.status===409&&error.code==='PROJECT_CATALOG_PAGE_UNAVAILABLE');
 assert.deepEqual(db.prepare('SELECT revision,data FROM workspace_header').all(),before);assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_records').get().n,rows);db.close();
});

test('catalog retains the existing workspace-reader boundary and refuses reviewers',()=>{
 const owner=testAuthority(),reviewer=testReviewerAuthority();
 authorizeRoute(owner.principal,'GET','/api/projects/catalog');assert.throws(()=>authorizeRoute(reviewer.principal,'GET','/api/projects/catalog'),{code:'REVIEWER_READ_ONLY'});
});
