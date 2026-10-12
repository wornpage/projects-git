import {syntaxLanguage,syntaxWithinLimit} from './syntax-languages.js';
export {syntaxLanguage} from './syntax-languages.js';

// One bounded worker queue per page. A slow grammar cannot block navigation.
export function createSyntaxClient({createWorker=()=>new Worker(new URL('./vendor/prism-1.30.0/syntax-worker.js',import.meta.url)),schedule=setTimeout,cancel=clearTimeout,available=()=>typeof Worker!=='undefined'}={}) {
  const queue=[];let worker=null,active=null,sequence=0;
  const finish=(result,reset=false)=>{
    if(!active)return;
    cancel(active.timer);const job=active;active=null;
    if(reset){worker?.terminate();worker=null;}
    job.resolve(result);pump();
  };
  const pump=()=>{
    if(active||!queue.length)return;
    active=queue.shift();
    const job=active;
    active.timer=schedule(()=>{if(active===job)finish({status:'plain',reason:'timeout'},true);},1500);
    try{
      if(!worker){
        worker=createWorker();const current=worker;
        worker.onmessage=event=>{if(worker===current&&active&&event.data?.id===active.id)finish(event.data.result);};
        worker.onerror=()=>{if(worker===current)finish({status:'plain',reason:'unavailable'},true);};
      }
      worker.postMessage({id:active.id,...active.input});
    }catch{finish({status:'plain',reason:'unavailable'},true);}
  };
  return (path,input)=>{
    const language=syntaxLanguage(path);
    if(!language)return Promise.resolve({status:'plain',reason:'unsupported'});
    if(!syntaxWithinLimit(input))return Promise.resolve({status:'plain',reason:'large'});
    if(!available())return Promise.resolve({status:'plain',reason:'unavailable'});
    if(queue.length>=8)return Promise.resolve({status:'plain',reason:'busy'});
    return new Promise(resolve=>{queue.push({id:++sequence,input:{...input,language:language.id},resolve});pump();});
  };
}
export const highlightSyntax=createSyntaxClient();
// Bound mounted token nodes separately from worker input and lexical context.
export const SYNTAX_RENDER_LINES=200;
export function syntaxRenderWithinLimit(lines) {
  return Array.isArray(lines)&&lines.length<=SYNTAX_RENDER_LINES&&lines.every(Array.isArray)
    &&lines.reduce((count,line)=>count+line.length,0)<=2000;
}
const kinds=new Set(['comment','keyword','string','number','function','type','property','operator']);
export function paintSyntax(node,text,tokens) {
  if(!Array.isArray(tokens)||tokens.some(token=>typeof token?.text!=='string')||tokens.map(token=>token.text).join('')!==text){node.textContent=text;return false;}
  node.replaceChildren(...tokens.map(token=>{
    if(!kinds.has(token.kind))return document.createTextNode(token.text);
    const span=document.createElement('span');span.className='syntax-token-'+token.kind;span.textContent=token.text;return span;
  }));return true;
}
export function syntaxLabel(language,result,enabled=true){
  if(!enabled)return 'Plain text';
  if(!language)return 'Plain text · unrecognized language';
  if(!result)return language.label+' · coloring…';
  if(result.status==='colored')return language.label;
  return language.label+' · plain text'+(result.reason==='large'?' (large section)':'');
}
