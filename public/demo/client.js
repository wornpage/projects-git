import {createExampleWorkspace,exampleIds} from './workspace.js';
import {parseWorkspacePage,projectWorkspace} from '../workspace-page.js';

// This explicit demo boundary never delegates a request to the real HTTP client.
export function createDemoApi(){
  const snapshot=createExampleWorkspace();
  return async (path,body)=>{
    if(body!==undefined)throw Object.assign(Error('This example is read-only. No workspace action was sent.'),{status:405,code:'DEMO_READ_ONLY'});
    if(path==='/api/workspace')return structuredClone(snapshot);
    if(path.startsWith('/api/workspace?'))return projectWorkspace(structuredClone(snapshot),parseWorkspacePage(path.split('?')[1]));
    throw Object.assign(Error('That operation is unavailable in the read-only example.'),{status:404,code:'DEMO_NOT_AVAILABLE'});
  };
}

export function installDemoGuide(document){
  const guide=document.getElementById('demo-guide');
  if(!guide)throw Error('Demo document is missing its guide.');
  const stages=[['overview','','1 · Requirements'],['work','','2 · Agent work'],['review','candidate-changes','3 · Changes'],
    ['review','verification','4 · Checks'],['review','code-review','5 · Independent review'],['review','review-decision','6 · Owner decision'],['evidence','','7 · Merge record']];
  const nav=document.createElement('nav');nav.setAttribute('aria-label','Guided example');
  for(const [view,section,label] of stages){const link=document.createElement('a');link.className='demo-step';link.textContent=label;
    link.href='?'+new URLSearchParams({view,task:exampleIds.task,candidate:exampleIds.safe})+(section?'#'+section:'');
    nav.append(link);}
  guide.append(nav);
}

export function updateDemoGuide(document,{view,taskId,runId,hash}){
  for(const link of document.querySelectorAll('#demo-guide .demo-step')){
    const target=new URL(link.href);
    const active=taskId===exampleIds.task&&runId===exampleIds.safe&&target.searchParams.get('view')===view&&target.hash===hash;
    if(active)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');
  }
}
