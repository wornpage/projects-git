import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handler,req,admit,token} from './helpers/trial-http.mjs';

function local(t,options){const f=fixture(options);t.after(()=>{f.sql.db.close();for(const c of f.contexts.values())c.db.close();});return f;}

test('a retained admission recovers failed alarm scheduling before status or resource authority can succeed',async t=>{
  const f=local(t),jwt=await token(),storage=f.registry.ctx.storage,original=storage.setAlarm;let failures=0;
  storage.setAlarm=async time=>{if(failures++===0)throw Error('Controlled local alarm failure');return original(time);};
  assert.ok((await handler(req('/api/trial',jwt,{}),f.env)).status>=500);
  assert.equal(f.sql.storage.sql.exec('SELECT count(*) n FROM trial_admissions').one().n,1);
  assert.equal(f.contexts.size,0);assert.equal(await storage.getAlarm(),null);
  const status=await handler(req('/api/trial',jwt),f.env);assert.equal(status.status,200);
  assert.equal((await status.json()).status,'admitted');assert.ok((await storage.getAlarm())>Date.now());
});

test('closure during allowance lookup cannot return an earlier ready/open sample view',async t=>{
  const f=local(t,{artifacts:{}}),jwt=await token();await admit(f,jwt);
  const controls=f.registry.controls.bind(f.registry);let closed=false;
  f.registry.controls=async(...args)=>{if(!closed){closed=true;assert.equal((await handler(req('/api/trial/close',jwt,{}),f.env)).status,200);}return controls(...args);};
  const result=await handler(req('/api/trial/sample',jwt),f.env);assert.equal(result.status,403);assert.equal((await result.json()).code,'TRIAL_CLOSED');
});
