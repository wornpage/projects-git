import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {agents,privateDirectory,receipt,ok,passed,save} from './client.mjs';
import {git} from './git.mjs';
let failure;
try{
  const {project}=JSON.parse(await readFile(join(privateDirectory,'hosted-admissions.json'),'utf8'));
  const created=await ok('owner','/api/tasks',{source:'project',projectId:project.projectId,tasks:Array.from({length:3},(_,i)=>({title:'Real container candidate '+i,purpose:'Qualify shared verification capacity and retained recovery.',criteria:['The committed qualification marker matches its trusted expectation.'],owner:'Scripted qualification'}))});
  const candidates=[];
  // Persist each issued credential before using it so a failed harness does not
  // recreate assignments or lose their one-time credential response.
  const privatePath=join(privateDirectory,'container-candidates.json');
  for(let i=0;i<3;i++){
    const assignment=await ok('owner',`/api/tasks/${created.taskIds[i]}/agents`,{label:'Scripted Git fixture '+i,agentClientId:agents[i].client_id});
    assert.ok(assignment.credentials);const candidate={index:i,taskId:created.taskIds[i],runId:assignment.runId,credentials:assignment.credentials,directory:resolve('qa/identity-concurrency/hosted/candidate-'+assignment.runId)};
    candidates.push(candidate);await writeFile(privatePath,JSON.stringify(candidates),{mode:0o600});
    await ok(i,`/api/runs/${candidate.runId}/start`,{});
    await mkdir(candidate.directory,{recursive:true});
    await git(['clone','--no-checkout',candidate.credentials.remote,'.'],candidate.directory,candidate.credentials);
    await git(['checkout','-b',candidate.credentials.branch,candidate.credentials.baseCommit],candidate.directory,candidate.credentials);
    await git(['config','user.name','Scripted qualification fixture'],candidate.directory);
    await git(['config','user.email','fixture@projects.invalid'],candidate.directory);
    candidate.expectedMarker='candidate-'+i+' '+candidate.runId+'\n';
    await writeFile(join(candidate.directory,'qualification.txt'),candidate.expectedMarker);
    await git(['add','qualification.txt'],candidate.directory);await git(['commit','-m','Retain scripted container qualification marker'],candidate.directory);
    candidate.head=await git(['rev-parse','HEAD'],candidate.directory);
    await writeFile(privatePath,JSON.stringify(candidates),{mode:0o600});
    await git(['push','origin','HEAD:refs/heads/'+candidate.credentials.branch],candidate.directory,candidate.credentials);
    const state=await ok(i,`/api/runs/${candidate.runId}/submit`,{headCommit:candidate.head,summary:'Scripted Git fixture for private container qualification; no model inference.'});
    assert.equal(state.runs.find(r=>r.id===candidate.runId).status,'awaiting_review');
    receipt.requests.push({runId:candidate.runId,taskId:candidate.taskId,head:candidate.head,agent:agents[i].client_id});
  }
  passed('three authenticated agents push real Artifacts branches and submit retained candidate commits');
}catch(error){failure=error;}finally{await save('prepare-candidates',failure);}if(failure)throw failure;
