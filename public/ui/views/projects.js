import {el, panel, shortSha} from '../dom.js';
import {projectBrief} from '../../workbench-state.js';

// Workspace discovery is a read-only projection of the same project selectors.
export function createProjectsView({getContext, getProjectSelection, selectProject, switchView, openTaskComposer, changeProjectPage}) {
  function projectCard(project) {
    const {workspace}=getContext(),brief=projectBrief(workspace,project.id);
    const code=project.codeConnected===false ? 'Code unavailable' : workspace.provider==='cloudflare-artifacts' ? 'Artifacts code' : 'Workspace Git copy';
    const next=brief.next;
    const tasks=workspace.tasks.filter(task=>task.projectId===project.id),saved=getProjectSelection(project.id);
    const openTaskId=tasks.find(task=>task.id===saved?.taskId)?.id??tasks.at(-1)?.id;
    const savedRun=workspace.runs.find(run=>run.id===saved?.runId && run.taskId===openTaskId);
    return el('article',{class:'project-card','aria-labelledby':'project-title-'+project.id},
      el('div',{class:'project-card-top'},el('span',{class:'section-kicker'},code),
        el('span',{class:'project-admission '+(project.acceptingWork?'on':'paused')},project.acceptingWork?'Admission on':'Admission paused')),
      el('h2',{id:'project-title-'+project.id},openTaskId ? el('a',{href:'?view=overview&task='+encodeURIComponent(openTaskId)+(savedRun?'&candidate='+encodeURIComponent(savedRun.id):''),
        onclick:event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();selectProject(project.id);}},project.name) : project.name),
      el('p',{class:'project-code'},(project.defaultBranch??(workspace.provider==='local-git'?'main':'default branch'))+' · '+shortSha(project.mainCommit)),
      el('dl',{class:'project-card-counts'},[['Needs decision',brief.decisions],['Active tasks',brief.active],['Waiting',brief.waiting],['Ready to claim',brief.eligibleQueued]].map(([label,value])=>
        el('div',{},el('dt',{},label),el('dd',{},value+' / '+brief.total)))),
      el('div',{class:'project-card-next'},next ? el('div',{},el('strong',{},next.label),el('p',{},next.title)) : el('p',{},brief.total ? 'All '+brief.total+' task'+(brief.total===1?'':'s')+' integrated.' : 'No tasks queued.'),
        next ? el('a',{class:'text-link',href:'?view='+next.view+'&task='+encodeURIComponent(next.taskId)+(next.runId?'&candidate='+encodeURIComponent(next.runId):''),
          onclick:event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();switchView(next.view,next.taskId,next.runId??null);}},next.action+' →')
          : brief.total || !workspace.authentication || workspace.authentication.permissions.manage
            ? el('worn-button',{size:'sm',label:brief.total ? 'Open project →' : 'Add first task →',onclick:()=>brief.total ? selectProject(project.id) : openTaskComposer('project:'+project.id)})
            : el('p',{class:'small'},'The owner can add the first task.')));
  }
  return () => {
    const {workspace,busy}=getContext(),projects=Object.values(workspace.projects??{}),page=workspace.page;
    const pagination = () => page ? el('nav',{class:'project-pagination','aria-label':'Project pages'},
      el('p',{role:'status'},page.totalProjects ? `Showing ${page.offset+1}–${page.offset+projects.length} of ${page.totalProjects} projects` : '0 projects'),
      el('div',{class:'button-row'},
        el('button',{class:'button button-small',disabled:busy||page.previousOffset===null,onclick:()=>changeProjectPage(page.previousOffset)},'Previous projects'),
        el('button',{class:'button button-small',disabled:busy||page.nextOffset===null,onclick:()=>changeProjectPage(page.nextOffset)},'Next projects'),
        el('button',{class:'button button-small',disabled:busy,onclick:()=>changeProjectPage(0,true)},'Refresh projects'))) : null;
    return el('div',{class:'projects-home'},
      el('section',{class:'workspace-intro','aria-label':'Workspace overview'},
        el('div',{},el('p',{class:'section-kicker'},workspace.name),
          el('h2',{},'Work moves through projects.'),
          el('p',{},'Queue agreed tasks, follow agent changes, and decide what becomes part of the project.')),
        workspace.authentication && !workspace.authentication.permissions.manage ? null : el('button',{type:'button',class:'button button-primary',onclick:()=>openTaskComposer('repository')},'+ New project')),
      pagination(),
      projects.length ? el('div',{class:'project-directory'},projects.map(projectCard))
        : panel('Your first project',el('div',{class:'panel-body'},
          el('p',{},workspace.authentication && !workspace.authentication.permissions.manage ? 'The workspace owner connects projects and queues tasks. Your assigned work will appear here.' : 'Start with New project. Connect committed code, then describe one useful task.'),
          el('ol',{class:'journey-steps'},
            el('li',{},workspace.provider==='cloudflare-artifacts' ? 'Have the existing Artifacts repository name and full base commit ready. The current setup does not browse repositories for you.' : 'Have the local repository path and full base commit ready.'),
            el('li',{},'Write the task purpose and acceptance requirements.'),
            el('li',{},'Open Project settings → Connect agent for the assignment instructions. Your coding chat runs the agent.'),
            el('li',{},'Inspect the submitted change and configure independent checks. In the hosted app, assign a separate reviewer before making your decision.'),
            el('li',{},'Accept a suitable candidate, then merge it as a separate action. Merging does not deploy.')))),
      projects.length ? el('p',{class:'definition-note'},(page?page.totalProjects:projects.length)+' project'+((page?page.totalProjects:projects.length)===1?'':'s')+' total · Counts are tasks / all tasks in each project, including integrated work. Active and decision tasks can overlap. Ready to claim still requires admission, available code and capacity.') : null);
  };
}
