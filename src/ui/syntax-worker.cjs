// Bundled locally. Prism never touches the page, fetches a grammar or produces HTML.
globalThis.Prism={manual:true,disableWorkerMessageHandler:true};
const Prism=require('prismjs/components/prism-core.js');
require('prismjs/components/prism-markup.js');
require('prismjs/components/prism-css.js');
require('prismjs/components/prism-clike.js');
require('prismjs/components/prism-javascript.js');
require('prismjs/components/prism-typescript.js');
require('prismjs/components/prism-jsx.js');
require('prismjs/components/prism-tsx.js');
require('prismjs/components/prism-python.js');
require('prismjs/components/prism-ruby.js');
require('prismjs/components/prism-go.js');
require('prismjs/components/prism-rust.js');
require('prismjs/components/prism-java.js');
require('prismjs/components/prism-c.js');
require('prismjs/components/prism-cpp.js');
require('prismjs/components/prism-csharp.js');
require('prismjs/components/prism-json.js');
require('prismjs/components/prism-yaml.js');
require('prismjs/components/prism-toml.js');
require('prismjs/components/prism-sql.js');
require('prismjs/components/prism-bash.js');
require('prismjs/components/prism-powershell.js');
require('prismjs/components/prism-docker.js');
require('prismjs/components/prism-hcl.js');
require('prismjs/components/prism-markup-templating.js');
require('prismjs/components/prism-php.js');
require('prismjs/components/prism-markdown.js');
const {SYNTAX_LANGUAGES,SYNTAX_LIMITS,syntaxWithinLimit}=require('../../public/syntax-languages.js');
const categories={comment:'comment',prolog:'comment',doctype:'comment',cdata:'comment',
  string:'string',char:'string',regex:'string','attr-value':'string',
  keyword:'keyword',boolean:'keyword',builtin:'keyword',important:'keyword',
  number:'number',constant:'number',symbol:'number',function:'function','function-variable':'function',
  'class-name':'type',tag:'type',selector:'type',namespace:'type',property:'property','attr-name':'property',
  operator:'operator',punctuation:'operator'};
function tokenLines(text,language,budget) {
  const lines=[[]];
  function visit(value,kind='plain') {
    if(Array.isArray(value)){for(const item of value)visit(item,kind);return;}
    if(typeof value!=='string'){visit(value.content,categories[value.type]??kind);return;}
    const pieces=value.split('\n');
    for(let index=0;index<pieces.length;index++){
      if(index)lines.push([]);
      if(pieces[index]){
        if(++budget.count>SYNTAX_LIMITS.tokens)throw Error('Token limit');
        lines.at(-1).push({text:pieces[index],kind});
      }
    }
  }
  const environment={code:text,grammar:Prism.languages[language],language};
  Prism.hooks.run('before-tokenize',environment);
  environment.tokens=Prism.tokenize(environment.code,environment.grammar);
  Prism.hooks.run('after-tokenize',environment);
  visit(environment.tokens);
  if(lines.map(line=>line.map(token=>token.text).join('')).join('\n')!==text)throw Error('Source changed');
  return lines;
}
function highlight(input) {
  if(!Object.hasOwn(SYNTAX_LANGUAGES,input.language))return {status:'plain',reason:'unsupported'};
  if(!syntaxWithinLimit(input))return {status:'plain',reason:'large'};
  try {
    const budget={count:0};
    if(input.mode==='source')return {status:'colored',lines:tokenLines(input.text,input.language,budget)};
    const rows=input.rows,lines=rows.map(row=>[{text:row.text,kind:'plain'}]);
    let group=[];
    const flush=()=>{
      // Tokenize base and head separately. A removed quote/comment must not
      // change the grammar state of added code; retain context across pages.
      for(const side of ['deletion','addition']){
        const selected=group.filter(index=>rows[index].kind===side||rows[index].kind==='context'&&rows[index].text.startsWith(' '));
        if(!selected.length)continue;
        const colored=tokenLines(selected.map(index=>rows[index].text.slice(1)).join('\n'),input.language,budget);
        selected.forEach((index,line)=>{lines[index]=[{text:rows[index].text[0],kind:'plain'},...colored[line]];});
      }
      group=[];
    };
    for(let index=0;index<rows.length;index++){
      if(rows[index].kind==='hunk'||rows[index].kind==='meta')flush();
      else if(rows[index].kind!=='context'||rows[index].text.startsWith(' '))group.push(index);
    }
    flush();
    if(lines.some((line,index)=>line.map(token=>token.text).join('')!==rows[index].text))throw Error('Patch changed');
    return {status:'colored',lines};
  }catch{return {status:'plain',reason:'unavailable'};}
}
if(typeof self!=='undefined'&&typeof self.postMessage==='function')self.onmessage=event=>{
  const {id,...input}=event.data;self.postMessage({id,result:highlight(input)});
};
module.exports={highlight};
