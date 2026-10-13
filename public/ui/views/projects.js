import {el, panel, shortSha} from '../dom.js';
import {projectBrief} from '../../workbench-state.js';

// Workspace discovery is a read-only projection of the same project selectors.
export function createProjectsView({getContext, disclosure, getProjectSelection, selectProject, switchView, openTaskComposer, changeProjectPage, createStarter}) {
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
      el('h2',{id:'project-title-'+project.id},openTaskId ? el('a',{href:'?view=queue&project='+encodeURIComponent(project.id),
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
      el('p',{id:'projects-page-status',role:'status',tabindex:'-1'},page.totalProjects ? `Showing ${page.offset+1}–${page.offset+projects.length} of ${page.totalProjects} projects` : '0 projects'),
      el('div',{class:'button-row'},
        page.previousOffset!==null||page.nextOffset!==null ? [
        el('button',{id:'projects-previous','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy||page.previousOffset===null,onclick:()=>changeProjectPage(page.previousOffset)},'Previous projects'),
        el('button',{id:'projects-next','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy||page.nextOffset===null,onclick:()=>changeProjectPage(page.nextOffset)},'Next projects')] : null,
        el('button',{id:'projects-refresh','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy,onclick:()=>changeProjectPage(0,true)},'Refresh projects'))) : null;
    return el('div',{class:'projects-home'},
      workspace.personalWorkspace && !projects.length ? panel('Your isolated workspace', el('div',{class:'panel-body'},
        el('p',{},'Your projects, tasks and repositories are separate from other visitors and the working workspace. Start with a fresh checkout project, then edit its task queue, requirements and project policy.'),
        el('p',{class:'small muted'},'This trial has no connected agents or model key. It does not run agents or manufacture completed work.'),
        !projects.length && (!page || page.totalProjects === 0) && workspace.personalWorkspace.starterAvailable
          ? el('button',{type:'button',class:'button button-primary',disabled:busy,onclick:createStarter},busy?'Preparing starter…':'Create my starter project') : null)) : null,
      workspace.authentication && !workspace.authentication.permissions.manage ? null : el('div',{class:'directory-actions'},
        el('button',{type:'button',class:'button button-primary button-small',onclick:()=>openTaskComposer('repository')},'+ New project'),
        workspace.capabilities?.demo ? el('button',{type:'button',class:'button button-small',onclick:()=>openTaskComposer('sample')},'Try a sample project') : null),
      projects.length ? el('ul',{class:'project-directory collection-list','aria-label':'Projects'},projects.map(project=>el('li',{},projectCard(project))))
        : workspace.personalWorkspace ? null : panel('Your first project',el('div',{class:'panel-body'},
          el('p',{},workspace.authentication && !workspace.authentication.permissions.manage ? 'The workspace owner connects projects and queues tasks. Your assigned work will appear here.' : 'Start with New project. Connect committed code, then describe one useful task.'),
          el('ol',{class:'journey-steps'},
            el('li',{},workspace.provider==='cloudflare-artifacts' ? 'Have the existing Artifacts repository name and full base commit ready. The current setup does not browse repositories for you.' : 'Enter your local repository path, read its current commit, and confirm the code to use.'),
            el('li',{},'Write the task purpose and acceptance requirements.'),
            el('li',{},'Open Project settings → Connect agent for the assignment instructions. Your coding chat runs the agent.'),
            el('li',{},'Inspect the submitted change and configure independent checks. In the hosted app, assign a separate reviewer before making your decision.'),
            el('li',{},'Accept a suitable candidate, then merge it as a separate action. Merging does not deploy.')))),
      pagination(),
      projects.length ? el('div',{},
        !page?el('p',{class:'definition-note'},projects.length+' project'+(projects.length===1?'':'s')+' total'):null,
        disclosure('project-count-help','About task counts',el('p',{},'Counts are tasks / all tasks in each project, including integrated work. Active and decision tasks can overlap. Ready to claim also requires admission, available code and execution capacity.'))) : null,
      workspace.personalWorkspace && projects.length ? el('details',{class:'personal-workspace-note'},el('summary',{},'About your isolated workspace'),
        el('p',{},'Your projects, tasks and repositories are separate from other visitors and the working workspace. This trial has no connected agents or model key; it does not manufacture completed work.')) : null);
  };
}
