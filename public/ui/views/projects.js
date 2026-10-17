import {el, panel, shortSha, dateTime} from '../dom.js';
import {projectAttentionBrief} from '../../workbench-state.js';

// Workspace discovery is a read-only projection of the same project selectors.
export function createProjectsView({getContext, disclosure, collections, selectProject, switchView, openTaskComposer, openProjectSearch, changeProjectPage, createStarter}) {
  function repositoryRow({project, brief}) {
    const {workspace,demo}=getContext();
    const code=project.codeConnected===false ? 'Code unavailable' : workspace.provider==='cloudflare-artifacts' ? 'Cloudflare Artifacts' : 'Workspace Git copy';
    const next=brief.next;
    const canManage=!workspace.authentication || workspace.authentication.permissions.manage;
    const counts=[['Needs attention',brief.attention],['Active tasks',brief.active],
      ...(brief.waiting || brief.eligibleQueued ? [['Waiting',brief.waiting],['Ready to claim',brief.eligibleQueued]] : [])];
    return el('article',{class:'repository-row','aria-labelledby':'project-title-'+project.id},
      el('div',{class:'repository-identity'},
        el('div',{class:'repository-name'},
          el('h3',{id:'project-title-'+project.id},brief.total ? el('a',{href:'?view=queue&project='+encodeURIComponent(project.id),
            onclick:event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();selectProject(project.id);}},project.name) : project.name),
          workspace.authentication && !demo && !workspace.personalWorkspace ? el('span',{class:'repository-private'},'Private') : null),
        el('p',{class:'project-code'},(project.defaultBranch??(workspace.provider==='local-git'?'main':'default branch'))+' · '+shortSha(project.mainCommit)),
        el('div',{class:'repository-meta'},el('span',{},code),
          el('span',{class:'repository-admission'},project.acceptingWork!==false?'Admission on':'Admission paused'))),
      brief.total ? el('dl',{class:'repository-counts'},counts.map(([label,value])=>
        el('div',{},el('dt',{},label),el('dd',{},value+' / '+brief.total)))) : el('p',{class:'repository-work-empty'},'0 tasks'),
      el('div',{class:'repository-next'},
        project.codeConnected===false ? [el('strong',{},'Code unavailable'),el('p',{},'Restore retained code before admitting work.'),
          canManage ? el('button',{class:'text-link',onclick:()=>selectProject(project.id)},'Open project →') : null]
        : [next ? el('div',{},el('strong',{},next.label),el('p',{},next.title)) : el('p',{},brief.total ? 'All '+brief.total+' task'+(brief.total===1?'':'s')+' integrated.' : 'No tasks queued.'),
          next ? el('a',{class:'text-link',href:'?view='+next.view+'&task='+encodeURIComponent(next.taskId)+(next.runId?'&candidate='+encodeURIComponent(next.runId):''),
            onclick:event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();switchView(next.view,next.taskId,next.runId??null);}},next.action+' →')
            : brief.total || canManage
              ? el('worn-button',{size:'sm',label:brief.total ? 'Open project →' : 'Add first task →',onclick:()=>brief.total ? selectProject(project.id) : openTaskComposer('project:'+project.id)})
              : el('p',{class:'small'},'The owner can add the first task.')]));
  }
  return () => {
    const {workspace,busy,demo}=getContext(),projects=Object.values(workspace.projects??{}),page=workspace.page;
    const rows=projects.map(project=>({project,brief:projectAttentionBrief(workspace,project.id)}));
    const matches=(row,filter)=>filter==='all' || filter==='attention'&&row.brief.needsAttention
      || filter==='review'&&row.brief.review>0 || filter==='blocked'&&(row.brief.blocked>0||row.project.codeConnected===false)
      || filter==='active'&&row.brief.active>0;
    const catalog=collections({id:'repository-catalog',label:'Loaded repositories',items:rows,text:row=>row.project.name,
      filters:[['all','All'],['attention','Needs attention'],['review','Review or merge'],['blocked','Blocked'],['active','Active work']]
        .map(([value,label])=>[value,label+' ('+rows.filter(row=>matches(row,value)).length+' / '+rows.length+')']),
      matches,sorts:[['attention','Attention first'],['name','Name within groups']],sortKey:(row,sort)=>sort==='name'?row.project.name:row.brief.priority,
      pageSize:20});
    const group=(title,items,attention=false)=>items.length ? el('section',{class:'repository-group'+(attention?' attention-group':''),'aria-label':title},
      el('div',{class:'repository-group-heading'},el('h2',{},title),el('span',{},items.length+' / '+rows.length+' loaded repositories')),
      el('ul',{class:'repository-list collection-list','aria-label':title},items.map(row=>el('li',{},repositoryRow(row))))) : null;
    const pagination = () => page ? el('nav',{class:'project-pagination','aria-label':'Project pages'},
      el('p',{id:'projects-page-status',role:'status',tabindex:'-1'},page.totalProjects ? `Loaded projects ${page.offset+1}–${page.offset+projects.length} of ${page.totalProjects}` : '0 projects'),
      el('div',{class:'button-row'},
        page.previousOffset!==null||page.nextOffset!==null ? [
        el('button',{id:'projects-previous','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy||page.previousOffset===null,onclick:()=>changeProjectPage(page.previousOffset)},'Previous projects'),
        el('button',{id:'projects-next','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy||page.nextOffset===null,onclick:()=>changeProjectPage(page.nextOffset)},'Next projects')] : null,
        el('button',{id:'projects-refresh','data-focus-fallback':'projects-page-status',class:'button button-small',disabled:busy,onclick:()=>changeProjectPage(0,true)},'Refresh projects'))) : null;
    return el('div',{class:'projects-home'},
      workspace.trial?.workflowReady===false ? panel('Trial workspace preview',el('div',{class:'panel-body'},
        el('p',{},'Your reservation is saved. This separate workspace is read-only while repository setup is prepared.'),
        el('p',{},'Repository creation, agents, checks and exports are not available yet.'),
        el('p',{class:'small muted'},'Trial access expires '+dateTime(workspace.trial.expiresAt)+'.'),
        el('a',{class:'button button-small',href:'/trial/signup'},'Manage trial reservation'))) : null,
      workspace.personalWorkspace && !projects.length ? panel('Your isolated workspace', el('div',{class:'panel-body'},
        el('p',{},'Your projects, tasks and repositories are separate from other visitors and the working workspace. Start with a fresh checkout project, then edit its task queue, requirements and project policy.'),
        el('p',{class:'small muted'},'This trial has no connected agents or model key. It does not run agents or manufacture completed work.'),
        !projects.length && (!page || page.totalProjects === 0) && workspace.personalWorkspace.starterAvailable
          ? el('button',{type:'button',class:'button button-primary',disabled:busy,onclick:createStarter},busy?'Preparing starter…':'Create my starter project') : null)) : null,
      workspace.authentication && !workspace.authentication.permissions.manage ? null : el('div',{class:'directory-actions'},
        el('button',{type:'button',class:'button button-primary button-small',disabled:busy,onclick:()=>openTaskComposer('repository')},'+ New project'),
        workspace.capabilities?.demo ? el('button',{type:'button',class:'button button-small',onclick:()=>openTaskComposer('sample')},'Try a sample project') : null),
      projects.length ? el('section',{class:'repository-catalog','aria-label':'Connected repositories'},
        el('div',{class:'repository-catalog-heading'},el('div',{},el('h2',{},'Connected repositories'),
          el('p',{class:'small muted'},(demo?'Example data':workspace.provider==='cloudflare-artifacts'?'Cloudflare Artifacts':'Local Git workspace')+' · '+rows.filter(row=>row.brief.needsAttention).length+' / '+rows.length+' need attention on this page')),
          el('button',{class:'button button-small',type:'button',onclick:openProjectSearch},'Find across workspace')),
        el('p',{class:'repository-scope'},rows.length+' loaded / '+(page?.totalProjects??rows.length)+' connected projects. Attention order and filters apply to this page. Find across workspace searches all project names.'),
        catalog.controls,
        group('Needs attention',catalog.items.filter(row=>row.brief.needsAttention),true),
        group('Other repositories',catalog.items.filter(row=>!row.brief.needsAttention)),
        !catalog.items.length ? el('p',{class:'no-command-results'},'No loaded repositories match these filters. Clear the filters or find a project across the workspace.') : null,
        catalog.navigation)
        : workspace.personalWorkspace || workspace.trial ? null : panel('Your first project',el('div',{class:'panel-body'},
          el('p',{},workspace.authentication && !workspace.authentication.permissions.manage ? 'The workspace owner connects projects and queues tasks. Your assigned work will appear here.' : workspace.capabilities?.repositoryCreate ? 'Start with New project. Create a private repository or connect existing code, then describe one useful task.' : 'Start with New project. Connect committed code, then describe one useful task.'),
          el('ol',{class:'journey-steps'},
            el('li',{},workspace.capabilities?.repositoryCreate ? 'Choose Create repository to start with a README, or connect an existing Artifacts repository and confirm its current commit.' : workspace.provider==='cloudflare-artifacts' ? 'Choose an Artifacts repository in New project, then confirm the loaded default branch and base commit.' : 'Enter your local repository path, read its current commit, and confirm the code to use.'),
            el('li',{},'Write the task purpose and acceptance requirements.'),
            el('li',{},'Open Project settings → Connect agent for the assignment instructions. Your coding chat runs the agent.'),
            el('li',{},'Configure independent checks for submitted changes. In the hosted app, assign an independent reviewer.'),
            el('li',{},workspace.provider==='cloudflare-artifacts'
              ? 'Choose integration policy in Project settings. Optional automatic integration handles eligible candidates after current checks and independent review; alternatives and exceptions need an owner decision. Manual acceptance and merge remain available. Merging does not deploy.'
              : 'Accept a suitable candidate, then request its guarded merge. The hosted app also supports optional automatic integration. Merging does not deploy.')))),
      pagination(),
      projects.length ? el('div',{},
        disclosure('project-count-help','About catalog counts',
          el('p',{},'Filters count repositories on the loaded page and can overlap. Needs attention includes review, repair, base updates and recovery. Review or merge includes independent review, owner decisions and manual integration. Blocked includes missing or stale checks, failed checks, invalid or stale reviews, reviewer-requested changes, invalid prerequisites, unavailable code and stopped integration. Paused admission alone is not a failure.'),
          el('p',{},'Row counts are tasks / all tasks in that project, including integrated work. Active tasks include assigned agents, running agents and pending checks. Waiting and active tasks can overlap. Ready to claim also requires admission, available code and execution capacity. Passing checks, independent review, acceptance and merge remain separate.'))) : null,
      workspace.personalWorkspace && projects.length ? el('details',{class:'personal-workspace-note'},el('summary',{},'About your isolated workspace'),
        el('p',{},'Your projects, tasks and repositories are separate from other visitors and the working workspace. This trial has no connected agents or model key; it does not manufacture completed work.')) : null);
  };
}
