// The same navigation nodes and counters live in the sidebar or phone drawer.
export function createCompactNavigation({document,getWorkspace,openInspector,onRestore}) {
  const find=id=>document.getElementById(id);
  const trigger=find('open-workspace-navigation'),home=find('workspace-home'),views=find('project-views');
  let open=false;
  trigger.addEventListener('click',()=>{
    if(!getWorkspace()||document.querySelector('dialog[open]'))return;
    const body=document.createElement('nav');
    body.className='compact-navigation';body.setAttribute('aria-label','Workspace views');
    open=true;body.append(home,views);
    openInspector('Navigate',body);
  });
  find('inspector-dialog').addEventListener('close',()=>{
    if(!open)return;
    open=false;find('project-navigation').before(home);onRestore();
  });
  return {isOpen:()=>open};
}
