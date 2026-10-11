import test from 'node:test';import assert from 'node:assert/strict';
import {expireQualificationOperation} from './qualification/expire-operation.ts';
test('qualification expiry targets pending assignment and base-update attempts without changing completed or foreign work',()=>{
  const fixture={operations:{assignment:{state:'pending',itemId:'assigned',attemptId:'a',leaseUntil:20},resolution:{state:'pending',sourceRunId:'source',attemptId:'b',leaseUntil:30},completed:{state:'complete',sourceRunId:'source',attemptId:'b',leaseUntil:40},foreign:{state:'pending',sourceRunId:'other',attemptId:'b',leaseUntil:50}}};
  assert.equal(expireQualificationOperation(fixture,'source','wrong'),false);
  assert.equal(expireQualificationOperation(fixture,'assigned','a'),true);assert.equal(fixture.operations.assignment.leaseUntil,0);
  assert.equal(expireQualificationOperation(fixture,'source','b'),true);assert.equal(fixture.operations.resolution.leaseUntil,0);
  assert.equal(fixture.operations.completed.leaseUntil,40);assert.equal(fixture.operations.foreign.leaseUntil,50);
});
