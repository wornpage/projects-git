import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDeliveryState,openDeliveryState} from '../src/local/durable-delivery-state.mjs';

const stages=['before-state-commit','after-state-commit','before-projection-temp-sync','after-projection-temp-sync','before-projection-rename','after-projection-rename',
  'after-projection-final-sync','before-projection-directory-sync','after-projection-directory-sync'];
for(const stage of stages)test('durable state fault at '+stage+' preserves one authoritative journal version',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'projects-delivery-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  createDeliveryState(root,{version:1,value:'initial'});let armed=true;
  const state=openDeliveryState(root,{storageFault:({stage:seen,transition})=>{if(armed&&transition==='reserve-push'&&seen===stage){armed=false;throw Error('scripted crash');}}});
  assert.throws(()=>state.save({version:1,value:'reserved'},'reserve-push'));
  const recovered=openDeliveryState(root),value=recovered.read(),committed=stage!=='before-state-commit';
  assert.equal(value.version,committed?2:1);assert.equal(value.value,committed?'reserved':'initial');
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'delivery.json'),'utf8')),value);
});
