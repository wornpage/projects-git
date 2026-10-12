// The same navigation nodes and counters live in the sidebar or phone drawer.
export function createCompactNavigation({document,getWorkspace,openInspector,onRestore}) {
  const find=id=>document.getElementById(id);
  const trigger=find('open-workspace-navigation'),home=find('workspace-home'),views=find('project-views');
  const dialog=find('inspector-dialog');
  let open=false;
  function restore() {
    if(!open)return false;
    open=false;
    const navigation=find('project-navigation');
    navigation.before(home);navigation.after(views);
    onRestore();
    return true;
  }
  trigger.addEventListener('click',()=>{
    if(!getWorkspace()||document.querySelector('dialog[open]'))return;
    const body=document.createElement('nav');
    body.className='compact-navigation';body.setAttribute('aria-label','Workspace views');
    openInspector('Navigate',body);
    open=true;body.append(home,views);
  });
  dialog.addEventListener('close',()=>{
    // A queued close may belong to the dialog before it was reopened.
    if(!dialog.open)restore();
  });
  return {isOpen:()=>open,restore};
}
