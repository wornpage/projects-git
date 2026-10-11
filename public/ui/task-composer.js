import {$, el} from './dom.js';

// A compact draft list and one editor; task-creation owns text and request IDs.
export function createTaskComposer({getContext, saveSession, updateChrome, showError}) {
  let owner=null, selected=0, lastCount=0;
  const fields=[['title','Task title',180,'What needs to change?'],['purpose','Purpose',4000,'Describe the result you want.'],
    ['criteria','Acceptance criteria · one per line',6000,'What must be true before acceptance?'],['owner','Coordinator',100,'Person or agent coordinating this task']];
  function selectDraft(index) {
    selected=index;renderTaskDrafts();
    $('#task-title-input'+(index?'-'+index:'')).focus();
  }
  function renderTaskDrafts() {
    const {workspace,taskStack}=getContext();
    if(owner!==taskStack||taskStack.length>lastCount)selected=taskStack.length-1;
    owner=taskStack;lastCount=taskStack.length;selected=Math.max(0,Math.min(selected,taskStack.length-1));
    const source=$('#task-source').value, sample=source==='sample', task=taskStack[selected], index=selected;
    const isCurrent=()=>getContext().taskStack===taskStack&&getContext().workspace?.id===workspace.id&&$('#task-source').value===source;
    const list=el('div',{class:'draft-list','aria-label':'Draft tasks'}), labels=[];
    taskStack.forEach((draft,position)=>{
      const title=el('strong',{},draft.title||'Define a task');labels.push(title);
      list.append(el('button',{type:'button',class:'draft-row','aria-pressed':position===selected,
        'aria-controls':'draft-editor',onclick:()=>{if(isCurrent())selectDraft(position);}},
        el('span',{class:'draft-index'},String(position+1).padStart(2,'0')),title));
    });
    const editor=el('section',{id:'draft-editor',class:'task-draft-fields','aria-label':'Editing draft '+(index+1)});
    editor.append(el('h3',{},'Task '+(index+1)+' of '+taskStack.length));
    for(const [key,label,max,placeholder] of fields){
      const id='task-'+key+'-input'+(index?'-'+index:'');
      const field=el(['purpose','criteria'].includes(key)?'textarea':'input',{id,required:true,maxlength:max,placeholder,readonly:sample});
      field.value=task[key];
      field.addEventListener('input',()=>{if(!isCurrent())return;task[key]=field.value;
        if(key==='title')labels[index].textContent=field.value||'Define a task';saveSession();});
      editor.append(el('label',{for:id},label),field);
      if(key==='owner')editor.append(el('p',{class:'small muted'},'A responsibility label; it does not grant access.'));
    }
    if(!sample&&workspace.capabilities?.dependencies){
      const projectId=source.startsWith('project:')?source.slice(8):null;
      const choices=[...workspace.tasks.filter(item=>item.projectId===projectId&&!item.mergedCommit).map(item=>({value:item.id,label:item.title+' · awaiting integration'})),
        ...taskStack.map((item,position)=>({value:'draft:'+(position+1),label:'Draft '+(position+1)+' · '+(item.title||'Untitled')})).filter((_,position)=>position!==index)];
      for(const id of task.dependsOn??[])if(!choices.some(item=>item.value===id)){
        const prior=workspace.tasks.find(item=>item.id===id);if(prior)choices.push({value:id,label:prior.title+' · integrated'});
      }
      if(choices.length){
        const prerequisites=el('fieldset',{class:'draft-prerequisites'},el('legend',{},'Wait for integration · optional'));
        for(const choice of choices)prerequisites.append(el('label',{},el('input',{type:'checkbox',value:choice.value,
          checked:(task.dependsOn??[]).includes(choice.value),onchange:event=>{if(!isCurrent())return;
            const values=new Set(task.dependsOn??[]);if(event.target.checked)values.add(choice.value);else values.delete(choice.value);
            task.dependsOn=[...values];saveSession();}}),el('span',{},choice.label)));
        editor.append(prerequisites);
      }
    }
    if(index&&!sample)editor.append(el('button',{type:'button',class:'button button-small',onclick:()=>{
      if(!isCurrent())return;
      if(taskStack.some((item,position)=>position!==index&&item.dependsOn?.includes('draft:'+(index+1)))){
        showError('Remove this draft from other prerequisites before deleting it.');return;
      }
      taskStack.splice(index,1);
      for(const item of taskStack)item.dependsOn=(item.dependsOn??[]).map(id=>id.startsWith('draft:')&&Number(id.slice(6))>index+1?'draft:'+(Number(id.slice(6))-1):id);
      selected=Math.min(index,taskStack.length-1);renderTaskDrafts();updateChrome();saveSession();
    }},'Remove this draft'));
    $('#task-drafts').replaceChildren(list,editor);
  }
  function validateDrafts() {
    const {taskStack}=getContext();
    const invalid=taskStack.findIndex(task=>fields.some(([key,,max])=>typeof task[key]!=='string'||!task[key].trim()||task[key].length>max));
    if(invalid<0)return true;
    selectDraft(invalid);showError('Complete the title, purpose, criteria and coordinator for task '+(invalid+1)+' before queueing the stack.');return false;
  }
  return {renderTaskDrafts,validateDrafts};
}
