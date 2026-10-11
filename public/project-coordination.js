import {projectContext,taskBriefing,projectBrief} from './workbench-state.js';
import {dependencyState} from './task-dependencies.js';
import {independentReviewStatus} from './review-boundary.js';

/** Project cards reuse the workflow selectors; this projection grants no actions. */
export function projectCoordination(workspace, projectId) {
  const context=projectContext(workspace,projectId), brief=projectBrief(workspace,projectId);
  const cards=context.tasks.map(task=>{
    const taskBrief=taskBriefing(workspace,task), dependencies=dependencyState(workspace,task);
    return {id:task.id,title:task.title,revision:task.revision??1,outcome:taskBrief.outcome,
      dependencies,retainedCandidates:taskBrief.total,
      candidates:taskBrief.candidates.map(item=>({id:item.run.id,label:item.run.label,status:item.run.status,
        outcome:item.outcome,active:item.active,headCommit:item.run.headCommit??null,
        files:[...(item.run.changedFiles??[])],blockers:item.blockers,
        review:workspace.provider==='cloudflare-artifacts'&&item.run.headCommit&&['awaiting_review','accepted','rejected','merged','superseded'].includes(item.run.status)?independentReviewStatus(workspace,item.run):null,
        overlaps:item.overlaps.map(other=>({runId:other.runId,headCommit:other.headCommit,paths:[...(other.paths??[])]})),
        observation:item.run.repositoryObservation??null})),
    };
  });
  const observations=[context.project.repositoryObservation,...context.runs.map(run=>run.repositoryObservation)]
    .filter(item=>item&&typeof item.observedAt==='string'&&Number.isFinite(Date.parse(item.observedAt)))
    .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt));
  return {projectId,projectName:context.project.name,version:workspace.version,totalTasks:context.tasks.length,
    totalCandidates:context.runs.length,brief,cards,capacity:workspace.capacity??null,
    automaticPolicyEnabled:workspace.provider==='cloudflare-artifacts'&&context.project.automaticMergePolicy?.enabled===true,
    admissionPaused:context.project.acceptingWork===false,lastObservation:observations[0]??null,
    eventCounts:workspace.artifactEvents??null,subscriptionCounts:workspace.artifactSubscriptions??null};
}
