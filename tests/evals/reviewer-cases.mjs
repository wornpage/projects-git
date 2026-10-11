import {createHash,randomUUID} from 'node:crypto';

const blob=(name,content)=>{const bytes=Buffer.from(content);return {name,base64:bytes.toString('base64'),
  oid:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};

function reviewCase(id,title,criteria,source,expected){
  const runId=randomUUID(),headCommit='b'.repeat(40),baseCommit='a'.repeat(40);
  const context={workspaceId:'scripted-review-evaluation',taskId:randomUUID(),runId,headCommit,baseCommit,
    taskRevision:1,requirements:{title,purpose:'Review the committed candidate against this contract.',criteria}};
  const contextId=createHash('sha256').update(JSON.stringify(context)).digest('hex');
  return {id,expected,packet:{format:'projects-code-review/v1',contextId,context,
    candidate:{changedFiles:['checkout.mjs'],diff:`--- a/checkout.mjs\n+++ b/checkout.mjs\n@@ -1 +1 @@\n-export const total = () => 0;\n+${source.trimEnd()}`},
    source:{commit:headCommit,files:[blob('checkout.mjs',source)]},
    baseSource:{commit:baseCommit,files:[blob('checkout.mjs','export const total = () => 0;\n')]},
    evidence:{source:'scripted-evaluation-fixture',verified:true,commit:headCommit,passed:1,total:1,exitCode:0,
      checks:[{name:'Synthetic precondition check',passed:true,detail:'Scripted evaluation context; no live verifier ran.'}]},
    verificationPolicy:{kind:'scripted-evaluation-fixture',note:'This synthetic case models a candidate admitted after passing checks; code-review claims still require source inspection.'}}};
}

export const cases=[
  reviewCase('unsafe-total','Safe integer checkout totals',['Reject any total outside Number.isSafeInteger.'],
    'export const total = items => items.reduce((sum,item) => sum + item.unitCents * item.quantity, 0);\n',
    {verdict:'changes_requested',blocking:[{path:'checkout.mjs',side:'head',startLine:1,endLine:1,priority:1}]}),
  reviewCase('clean-total','Safe integer checkout totals',['Accept nonnegative safe integer prices and positive safe integer quantities.','Reject unsafe products and sums.'],
    'export function total(items) { if (!Array.isArray(items)) throw new TypeError("cart"); let sum = 0; for (const item of items) { if (!Number.isSafeInteger(item.unitCents) || item.unitCents < 0 || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new RangeError("item"); const line = item.unitCents * item.quantity; if (!Number.isSafeInteger(line) || !Number.isSafeInteger(sum + line)) throw new RangeError("total"); sum += line; } return sum; }\n',
    {verdict:'pass',blocking:[]}),
  reviewCase('missing-quantity-check','Validated checkout quantities',['Reject zero, negative, and non-integer quantities.'],
    'export const total = items => items.reduce((sum,item) => sum + item.unitCents * item.quantity, 0);\n',
    {verdict:'changes_requested',blocking:[{path:'checkout.mjs',side:'head',startLine:1,endLine:1,priority:1}]})
];
