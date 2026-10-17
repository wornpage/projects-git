// Versioned, supplied code only. This starter deliberately needs validation work;
// creating it is not an agent run, a check result, or an accepted change.
export const TRIAL_SAMPLE = Object.freeze({
  id: 'checkout-v1',
  projectName: 'Trial sample · Checkout',
  description: 'Supplied checkout starter for an isolated Projects Git trial.',
  files: Object.freeze([
    Object.freeze({path:'README.md',content:'# Projects Git trial sample\n\nThis is supplied starter code, not completed agent work.\n\nThe task is to make checkout totals use safe integer cents and reject invalid prices, quantities and unsafe totals. The starting implementation is intentionally incomplete.\n\nRun the illustrative tests with `node --test tests/checkout.test.mjs`. They are not independent verification or a review decision.\n\nTrial repository setup does not enable coding agents, hosted checks, exports or automatic cleanup.\n'}),
    Object.freeze({path:'checkout.mjs',content:'// Starting point: the task is to add safe integer-cent arithmetic and validation.\nexport function checkoutTotal(items) {\n  return items.reduce((total, item) => total + item.unitCents * item.quantity, 0);\n}\n'}),
    Object.freeze({path:'package.json',content:'{"name":"projects-git-trial-sample","private":true,"type":"module","scripts":{"test":"node --test tests/checkout.test.mjs"}}\n'}),
    Object.freeze({path:'tests/checkout.test.mjs',content:'import test from "node:test";\nimport assert from "node:assert/strict";\nimport {checkoutTotal} from "../checkout.mjs";\n\ntest("sum integer cents",()=>assert.equal(checkoutTotal([{unitCents:1299,quantity:2},{unitCents:250,quantity:3}]),3348));\ntest("reject negative prices",()=>assert.throws(()=>checkoutTotal([{unitCents:-1,quantity:1}])));\ntest("reject zero quantities",()=>assert.throws(()=>checkoutTotal([{unitCents:100,quantity:0}])));\ntest("reject unsafe totals",()=>assert.throws(()=>checkoutTotal([{unitCents:Number.MAX_SAFE_INTEGER,quantity:2}])));\n'}),
  ]),
});

export function trialSampleName(workspaceId) {
  if(typeof workspaceId!=='string'||!/^trial-[a-f0-9]{64}$/.test(workspaceId))throw Error('Sample setup requires a derived trial workspace.');
  return 'sample-'+workspaceId.slice(6);
}
