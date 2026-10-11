import {el} from './dom.js';
import {collectionPage} from '../collection-page.js';

export function createCollectionPager({getScope,render}) {
  let scope=null;const states=new Map();
  return ({id,label,items,text,filters=[['all','All statuses']],matches,sorts=[['order','Original order'],['name','Name']],sortKey,pageSize=25})=>{
    const current=getScope();if(current!==scope){scope=current;states.clear();}
    if(!states.has(id))states.set(id,{query:'',filter:'all',sort:sorts[0][0],offset:0});
    const state=states.get(id),page=collectionPage(items,state,{text,matches,sortKey,pageSize});state.offset=page.offset;
    const change=(field,value)=>{state[field]=value;state.offset=0;render(true);};
    const controls=el('div',{class:'collection-controls','aria-label':label+' controls'},
      el('form',{class:'collection-filters',onsubmit:event=>{event.preventDefault();change('query',input.value);}},
        el('label',{for:id+'-query',class:'sr-only'},'Search '+label.toLowerCase()),
        el('input',{id:id+'-query',type:'search',maxlength:200,value:state.query,placeholder:'Search '+label.toLowerCase(),oninput:event=>change('query',event.target.value)}),
        filters.length>1?el('select',{id:id+'-filter','aria-label':label+' status',onchange:event=>change('filter',event.target.value)},filters.map(([value,name])=>el('option',{value,selected:value===state.filter},name))):null,
        el('select',{id:id+'-sort','aria-label':label+' order',onchange:event=>change('sort',event.target.value)},sorts.map(([value,name])=>el('option',{value,selected:value===state.sort},name))),
        state.query||state.filter!=='all'?el('button',{type:'button',class:'button button-small',onclick:()=>{state.query='';state.filter='all';state.offset=0;render(true);}},'Clear'):null));
    const navigation=el('nav',{class:'collection-page-controls','aria-label':label+' pages'},el('p',{role:'status'},`Showing ${page.from}–${page.to} · ${page.matched} matching / ${page.total} total ${label.toLowerCase()}`),
      page.previous!==null||page.next!==null ? [
        el('button',{type:'button',class:'button button-small',disabled:page.previous===null,onclick:()=>{state.offset=page.previous;render(true);}},'Previous '+label.toLowerCase()),
        el('button',{type:'button',class:'button button-small',disabled:page.next===null,onclick:()=>{state.offset=page.next;render(true);}},'Next '+label.toLowerCase())] : null);
    const input=controls.querySelector('#'+id+'-query');
    return {...page,controls,navigation};
  };
}
