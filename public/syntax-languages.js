// Explicit filenames only: unknown languages remain complete plain text.
export const SYNTAX_LANGUAGES = Object.freeze({
  javascript:['JavaScript','js','mjs','cjs'], typescript:['TypeScript','ts','mts','cts'],
  jsx:['JSX','jsx'], tsx:['TSX','tsx'], python:['Python','py','pyw'], ruby:['Ruby','rb'],
  go:['Go','go'], rust:['Rust','rs'], java:['Java','java'], c:['C','c','h'], cpp:['C++','cpp','cc','cxx','hpp','hxx'],
  csharp:['C#','cs'], markup:['HTML / XML','html','htm','xml','svg'], css:['CSS','css'],
  json:['JSON','json','jsonc'], yaml:['YAML','yaml','yml'], toml:['TOML','toml'], sql:['SQL','sql'],
  bash:['Shell','sh','bash','zsh'], powershell:['PowerShell','ps1','psm1','psd1'],
  docker:['Dockerfile','dockerfile'], hcl:['Terraform / HCL','tf','hcl'], php:['PHP','php'], markdown:['Markdown','md','markdown'],
});
export const SYNTAX_LIMITS = Object.freeze({characters:250000,lines:5000,tokens:50000});
const extensions = new Map(Object.entries(SYNTAX_LANGUAGES).flatMap(([id,[label,...suffixes]])=>suffixes.map(suffix=>[suffix,{id,label}])));
export function syntaxLanguage(path) {
  if(typeof path!=='string')return null;
  const name=path.split(/[\\/]/).at(-1).toLowerCase();
  if(name==='dockerfile'||name.startsWith('dockerfile.'))return extensions.get('dockerfile');
  return name.includes('.')?extensions.get(name.split('.').at(-1))??null:null;
}
export function syntaxWithinLimit(input) {
  if(input.mode==='source')return typeof input.text==='string'&&input.text.length<=SYNTAX_LIMITS.characters&&input.text.split('\n').length<=SYNTAX_LIMITS.lines;
  return input.mode==='diff'&&Array.isArray(input.rows)&&input.rows.length<=SYNTAX_LIMITS.lines
    &&input.rows.every(row=>typeof row?.text==='string'&&['meta','hunk','context','addition','deletion'].includes(row.kind))
    &&input.rows.reduce((size,row)=>size+row.text.length+1,0)<=SYNTAX_LIMITS.characters;
}
