import {independentReviewBinding} from '../review-boundary.js';

// Invented, credential-free teaching records. These are not Cloudflare receipts.
export const exampleIds={project:'00000000-0000-4000-8000-000000000001',task:'00000000-0000-4000-8000-000000000002',
  nextTask:'00000000-0000-4000-8000-000000000003',fast:'00000000-0000-4000-8000-000000000004',safe:'00000000-0000-4000-8000-000000000005'};
const base='a'.repeat(40),head='b'.repeat(40),other='c'.repeat(40),date=time=>`2026-10-07T${time}:00Z`;
const identity=(kind,id)=>({kind,id,workspaceId:'read-only-example',issuer:'https://identity.example.invalid',provider:'cloudflare-access',displayName:'Sample '+kind});
const checks=(commit,passed,operation)=>({verified:true,source:'independent-sandbox-checks',commit,taskRevision:1,passed,total:3,exitCode:passed===3?0:1,
  verifiedAt:date(operation?'10:13':'10:10'),command:'python -m unittest test_checkout',output:'Illustrative report: '+passed+' / 3 checks passing. No command was executed for this demo.',
  checks:[{name:'Valid totals in integer cents',passed:true,detail:'Sample: two units at 250 cents produce 500 cents.'},
    {name:'Reject invalid quantities',passed:passed===3,detail:passed===3?'Sample: zero and negative quantities are rejected.':'Sample failure: zero quantity was accepted.'},
    {name:'Reject unsafe totals',passed:passed===3,detail:passed===3?'Sample: totals above the safe integer limit are rejected.':'Sample failure: the safe integer limit was not checked.'}],
  ...(operation?{operation:'merge',attemptId:'sample-merge-attempt'}:{})});
const safeDiff=`diff --git a/checkout.py b/checkout.py
--- a/checkout.py
+++ b/checkout.py
@@ -1,2 +1,16 @@
 def checkout_total(items):
-    return 0
+    limit = 2**53 - 1
+    total = 0
+    for item in items:
+        unit = item["unit_cents"]
+        quantity = item["quantity"]
+        if type(unit) is not int or not 0 <= unit <= limit:
+            raise ValueError("Invalid unit price")
+        if type(quantity) is not int or quantity <= 0:
+            raise ValueError("Invalid quantity")
+        subtotal = unit * quantity
+        if subtotal > limit or total + subtotal > limit:
+            raise ValueError("Unsafe total")
+        total += subtotal
+    return total
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,3 @@
 # Checkout
+Totals use integer cents and reject invalid quantities.
+The safe integer limit is 2**53 - 1.
`;
export function createExampleWorkspace(){
  const task={id:exampleIds.task,projectId:exampleIds.project,title:'Make checkout totals trustworthy',origin:'artifacts',
    purpose:'Return a total in integer cents. Keep the input unchanged and reject values that cannot form a safe total.',
    criteria:['Add valid prices and quantities in integer cents.','Reject zero, negative or non-integer quantities.','Reject unsafe prices, products and totals.'],
    owner:'Sample project coordinator',ownerVersion:1,revision:1,baseCommit:base,status:'merged',acceptedRunId:exampleIds.safe,mergedCommit:head,
    repositoryName:'example-checkout',resultBranch:'main',createdAt:date('10:00'),dependsOn:[],
    revisions:[{revision:1,reason:'Sample task brief',at:date('10:00')}]};
  const run=(id,commit,label,status)=>({id,taskId:task.id,agent:'Scripted example agent',label,status,origin:'external-agent',
    agentIdentity:identity('agent','sample-builder-'+id.slice(-1)),branch:'example/'+(id===exampleIds.safe?'safe-totals':'quick-total'),baseCommit:base,headCommit:commit,
    changedFiles:id===exampleIds.safe?['checkout.py','README.md']:['checkout.py'],createdAt:date('10:01'),startedAt:date('10:02'),finishedAt:date(id===exampleIds.safe?'10:09':'10:06'),
    diff:id===exampleIds.safe?safeDiff:'diff --git a/checkout.py b/checkout.py\n--- a/checkout.py\n+++ b/checkout.py\n@@ -1,2 +1,2 @@\n def checkout_total(items):\n-    return 0\n+    return sum(item["unit_cents"] * item["quantity"] for item in items)\n',
    summary:id===exampleIds.safe?'Sample candidate: validate each item and bound every subtotal and total.':'Sample candidate: a short implementation that leaves invalid input and overflow unchecked.',
    evidence:checks(commit,id===exampleIds.safe?3:1),evidenceHistory:[],reviewAssignments:[]});
  const safe=run(exampleIds.safe,head,'Sample agent B · validated totals','merged'),fast=run(exampleIds.fast,other,'Sample agent A · quick sum','rejected');
  const workspace={schemaVersion:1,id:'read-only-example',name:'Read-only example',provider:'cloudflare-artifacts',version:1,createdAt:date('10:00'),
    demonstration:{kind:'read-only-sample',records:'synthetic',note:'Invented teaching records; not authenticated sessions or provider proof.'},
    projects:{[exampleIds.project]:{id:exampleIds.project,name:'Checkout service · example',kind:'artifacts',codeConnected:true,
      repositoryName:'example-checkout',defaultBranch:'main',mainCommit:head,owner:task.owner,acceptingWork:true,policyVersion:1}},
    tasks:[task,{id:exampleIds.nextTask,projectId:exampleIds.project,title:'Add receipt formatting',origin:'artifacts',purpose:'Build a readable receipt on top of the integrated total function.',
      criteria:['Show item quantities, prices and the final total.'],baseCommit:head,owner:task.owner,ownerVersion:1,revision:1,status:'open',acceptedRunId:null,mergedCommit:null,
      dependsOn:[task.id],createdAt:date('10:15'),repositoryName:'example-checkout',resultBranch:'main'}],runs:[fast,safe],
    authentication:{mode:'read-only-demo',principal:{kind:'viewer',id:'example-visitor',displayName:'Example visitor',issuer:'demo'},
      permissions:{read:true,manage:false,claim:false,execute:false,review:false,merge:false},agentClientIds:[],reviewerClientIds:[],reviewerSubjects:[]},
    capabilities:{model:false,repository:false,merge:false,verify:false,revise:false,handoff:false,coordination:true,dependencies:true,providerVerified:false,publish:false,retainedSearch:false},
    repositoryWorkflow:{busyTaskIds:[],imports:[]},recovery:{pendingMergeIntents:0,errors:[]},coordination:{},mergeStateByRun:{},
    capacity:{limit:4,occupied:0,running:0,reserved:0,queued:0,verification:{limit:2,occupied:0,waiting:0}},
    execution:{kind:'read-only-example',label:'Illustrative records · no agents running',inference:false},events:[]};
  safe.reviewAssignments=[{id:'sample-review-assignment',reviewerIds:['sample-independent-reviewer'],at:date('10:10')}];
  safe.codeReview={id:'sample-assessment',format:'projects-code-review-assessment/v2',assignmentId:'sample-review-assignment',verdict:'pass',
    summary:'Illustrative assessment: inspected the bound checks and the two changed files. Validation precedes accumulation and checks the total before returning it.',
    identity:identity('reviewer','sample-independent-reviewer'),context:independentReviewBinding(workspace,safe),findings:[],unresolvedFindingIds:[],resolvedPriorFindingIds:[],at:date('10:11')};
  safe.review={decision:'accept',reviewer:'Sample owner',identity:identity('owner','sample-owner'),headCommit:head,taskRevision:1,ownerVersion:1,
    codeReviewId:safe.codeReview.id,note:'Illustrative decision: choose the validated candidate. Acceptance was recorded before a separate merge.',at:date('10:12')};
  fast.review={decision:'reject',reviewer:'Sample owner',identity:identity('owner','sample-owner'),headCommit:other,taskRevision:1,ownerVersion:1,
    note:'Illustrative decision: retain this shorter alternative and its 1 / 3 report; it does not satisfy the input and overflow requirements.',at:date('10:12')};
  safe.evidenceHistory=[checks(head,3,'merge')];
  workspace.events=[['10:00','task.created','Sample brief queued.'],['10:02','run.started','Sample agents A and B start from the same base.'],
    ['10:10','run.verified','Sample reports: A 1 / 3; B 3 / 3.'],['10:11','run.code-reviewed','Sample independent reviewer assesses candidate B.'],
    ['10:12','run.reviewed','Sample owner accepts B and rejects A.'],['10:13','run.merged','Sample merge follows its own check attempt.'],
    ['10:15','task.created','A follow-up task remains in the same project.']].map(([time,type,message],index)=>({id:'sample-event-'+index,at:date(time),type,message,taskId:task.id,runId:safe.id}));
  return workspace;
}
