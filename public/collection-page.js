// Pages are display projections. Never replace or mutate workflow state with one.
export function collectionPage(items,state,{text=()=>'',matches=()=>true,sortKey=()=>'',pageSize=25}={}) {
  const words=state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const selected=items.map((item,index)=>({item,index})).filter(({item})=>matches(item,state.filter)&&words.every(word=>text(item).toLowerCase().includes(word)));
  if(state.sort!=='order')selected.sort((a,b)=>{
    const av=sortKey(a.item,state.sort),bv=sortKey(b.item,state.sort);
    const order=typeof av==='number'&&typeof bv==='number'?av-bv:String(av).localeCompare(String(bv));
    return (state.sort==='newest'?-order:order)||a.index-b.index;
  });
  const offset=Math.min(state.offset,Math.max(0,Math.ceil(selected.length/pageSize)-1)*pageSize);
  return {items:selected.slice(offset,offset+pageSize).map(({item})=>item),total:items.length,matched:selected.length,offset,pageSize,
    from:selected.length?offset+1:0,to:Math.min(offset+pageSize,selected.length),previous:offset?Math.max(0,offset-pageSize):null,next:offset+pageSize<selected.length?offset+pageSize:null};
}
