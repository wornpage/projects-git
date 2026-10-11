import test from 'node:test';
import assert from 'node:assert/strict';
import {testTotals,checkOutcome} from '../scripts/ci-receipt.mjs';
const tap=counts=>Object.entries({tests:4,pass:4,fail:0,cancelled:0,skipped:0,todo:0,...counts}).map(([key,value])=>'# '+key+' '+value).join('\n');
test('CI refuses a green process when Docker cases were skipped',()=>{
  const result=checkOutcome('tests',0,tap({pass:3,skipped:1}));assert.equal(result.status,'failed');assert.equal(result.totals.tests,4);assert.equal(result.totals.skipped,1);
});
test('CI retains failed test counts and refuses absent or inconsistent denominators',()=>{
  assert.equal(checkOutcome('tests',1,tap({pass:3,fail:1})).totals.fail,1);
  assert.equal(checkOutcome('tests',0,'all good').status,'failed');
  assert.throws(()=>testTotals(tap({pass:3})),/denominator/);
});
test('CI reads TAP and spec summaries and does not discard cancellation or todo',()=>{
  assert.equal(checkOutcome('tests',0,tap()).status,'passed');
  assert.equal(checkOutcome('tests',0,tap().replaceAll('#','ℹ')).status,'passed');
  assert.equal(checkOutcome('tests',0,tap({pass:3,cancelled:1})).status,'failed');
  assert.equal(checkOutcome('tests',0,tap({todo:1})).status,'failed');
});
test('CI preserves a nonzero native check outcome and rejects unknown phases',()=>{
  assert.deepEqual(checkOutcome('build',2,''),{status:'failed',exitCode:2});
  assert.throws(()=>checkOutcome('deploy',0,''));
});

test('CI refuses high-severity dependency findings and incomplete audit responses',()=>{
  const audit=counts=>JSON.stringify({metadata:{vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0,...counts}}});
  assert.equal(checkOutcome('audit',0,audit()).status,'passed');
  const high=checkOutcome('audit',0,audit({high:1,total:1}));
  assert.equal(high.status,'failed');assert.equal(high.vulnerabilities.high,1);
  assert.equal(checkOutcome('audit',0,audit({critical:1,total:1})).status,'failed');
  assert.equal(checkOutcome('audit',0,'{"error":{"code":"ENOAUDIT"}}').status,'failed');
  assert.equal(checkOutcome('audit',0,audit({total:1})).status,'failed');
});
