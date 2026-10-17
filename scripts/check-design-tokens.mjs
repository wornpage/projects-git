import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const files=['styles.css','workbench.css','reviewer.css','action-feedback.css','syntax.css','demo/demo.css'];
const errors=[];
for(const file of files){
 const css=await readFile(new URL('../public/'+file,import.meta.url),'utf8');
 const parsed=await transform(css,{loader:'css',sourcefile:file});
 errors.push(...parsed.warnings.map(w=>file+': '+w.text));
 for(const [,property,value] of css.matchAll(/(?:^|[;{])\s*(font(?:-size|-weight)?|line-height|letter-spacing|border(?:-[a-z-]+)?-radius|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|(?:row-|column-)?gap)\s*:\s*([^;{}]+)/g)){
  // One-pixel accessibility clipping, hairlines, and widths inside layout calculations are not spacing scale values.
  const inspect=value.replace(/(?:calc|max|min|clamp)\([^;]*?\)/g,match=>/100vw|100%/.test(match)?'':match);
  const raw=[...inspect.matchAll(/(-?\d*\.?\d+)(px|rem|em)/g)].filter(([,n,unit])=>!(unit==='px'&&Math.abs(Number(n))===1&&/^(padding|margin)/.test(property)));
  if(raw.length)errors.push(file+': '+property+': '+value.trim());
  if(['font-weight','line-height'].includes(property)&&/^\s*[1-9]/.test(value))errors.push(file+': untokenized '+property+': '+value.trim());
 }
}
if(errors.length)throw Error(errors.join('\n'));
console.log('Design tokens: six application stylesheets use shared type, spacing and radius scales; CSS parses without warnings.');
