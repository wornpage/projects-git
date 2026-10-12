import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {highlight} from '../src/ui/syntax-worker.cjs';
import {SYNTAX_LANGUAGES,syntaxLanguage,SYNTAX_LIMITS} from '../public/syntax-languages.js';
import {createSyntaxClient,paintSyntax,syntaxRenderWithinLimit} from '../public/code-syntax.js';
import {recordedDiff,diffWindow} from '../public/review-diff.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

const examples={javascript:['app.mjs','const answer = "hello"; // note'],typescript:['app.ts','const answer: number = 42;'],
  jsx:['view.jsx','const view = <main title="Hello">{count}</main>;'],tsx:['view.tsx','const view: Element = <main>{count}</main>;'],
  python:['app.py','def total(items):\n    return sum(items) # note'],ruby:['app.rb','def total(items)\n  items.sum\nend'],
  go:['app.go','package main\nfunc main() { println("hello") }'],rust:['app.rs','fn main() { let total: i32 = 42; }'],
  java:['App.java','public class App { int total = 42; }'],c:['app.c','int main(void) { return 0; }'],cpp:['app.cpp','class App { public: int total = 42; };'],
  csharp:['App.cs','public class App { string name = "hello"; }'],markup:['index.html','<main title="hello">&lt;script&gt;</main>'],css:['app.css','body { color: red; }'],
  json:['data.json','{"hello": true, "count": 42}'],yaml:['config.yml','name: hello\ncount: 42'],toml:['config.toml','[project]\nname = "hello"'],
  sql:['query.sql','SELECT name FROM projects WHERE id = 1;'],bash:['run.sh','#!/bin/sh\necho "$HOME"'],powershell:['run.ps1','Get-Content -Path "file.txt"'],
  docker:['Dockerfile','FROM node:24\nRUN node --version'],hcl:['main.tf','resource "example" "main" { name = "hello" }'],
  php:['index.php','<?php function total($items) { return count($items); } ?>'],markdown:['README.md','# Hello\n**Important** `code`'],
};
assert.deepEqual(Object.keys(examples).sort(),Object.keys(SYNTAX_LANGUAGES).sort());
for(const [language,[path,text]] of Object.entries(examples))test(`syntax preserves and colors ${language}`,()=>{
  assert.equal(syntaxLanguage(path).id,language);
  const result=highlight({language,mode:'source',text});assert.equal(result.status,'colored');
  assert.equal(result.lines.map(line=>line.map(token=>token.text).join('')).join('\n'),text);
  assert.ok(result.lines.flat().some(token=>token.kind!=='plain'));
});

test('unrecognized filenames and oversized text remain complete plain text without a worker',async()=>{
  let workers=0;const client=createSyntaxClient({createWorker:()=>{workers++;throw Error('Unexpected worker');},available:()=>true});
  assert.equal(syntaxLanguage('data.unknown'),null);assert.equal(syntaxLanguage('some/path'),null);
  assert.equal(syntaxLanguage('src/MODEL.PY').id,'python');assert.equal(syntaxLanguage('Dockerfile.production').id,'docker');
  assert.equal((await client('data.unknown',{mode:'source',text:'keep all'})).reason,'unsupported');
  assert.equal((await client('app.js',{mode:'source',text:'x'.repeat(SYNTAX_LIMITS.characters+1)})).reason,'large');
  assert.equal((await client('app.py',{mode:'source',text:'x\n'.repeat(20000)})).reason,'large');
  assert.equal(workers,0);
});

test('diff coloring keeps independent base/head lexical state, pages and every original byte',()=>{
  const patch='diff --git a/file.js b/file.js\n--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n-/* old comment\n-old\n-*/\n+const value = "new";\n+// new comment\n+return value;\n';
  const section=recordedDiff(patch,['file.js']).sections[0],result=highlight({language:'javascript',mode:'diff',rows:section.rows});
  assert.equal(result.status,'colored');assert.deepEqual(result.lines.map(line=>line.map(token=>token.text).join('')),section.rows.map(row=>row.text));
  assert.ok(result.lines[7].some(token=>token.kind==='keyword'&&token.text==='const'));
  assert.ok(result.lines[5].some(token=>token.kind==='comment'&&token.text.includes('old')));
  const rows=[{text:'@@ -0,0 +1,2000 @@',kind:'hunk'},...Array.from({length:2000},(_,i)=>({text:i===0?'+/* comment':i===1999?'+*/':'+line '+i,kind:'addition'}))];
  const large=highlight({language:'javascript',mode:'diff',rows});assert.equal(large.status,'colored');
  const page=diffWindow({rows},200);assert.equal(page.rows.length,200);
  assert.ok(large.lines[200].some(token=>token.kind==='comment'));
  assert.deepEqual(large.lines.map(line=>line.map(token=>token.text).join('')),rows.map(row=>row.text));
});

test('source coloring preserves unicode, CRLF, tabs and malicious-looking text through safe DOM nodes',()=>{
  const text='const x = "<img src=x onerror=alert(1)>";\r\n\t// café 😀\r\n';
  const result=highlight({language:'javascript',mode:'source',text});assert.equal(result.status,'colored');
  const {document}=installFakeDOM(),node=document.createElement('code');
  const tokens=result.lines[0];assert.equal(paintSyntax(node,text.split('\n')[0],tokens),true);
  assert.equal(node.textContent,text.split('\n')[0]);assert.equal(node.querySelector('img'),null);
  assert.equal(paintSyntax(node,text,[{text:'changed',kind:'keyword'}]),false);assert.equal(node.textContent,text);
  const mark=highlight({language:'markup',mode:'source',text:'<script>alert("unsafe")</script>'});
  paintSyntax(node,'<script>alert("unsafe")</script>',mark.lines[0]);assert.equal(node.querySelector('script'),null);
});

test('mounted syntax is bounded independently of full-file lexical analysis',()=>{
  const text=Array.from({length:2000},(_,index)=>`const item${index} = ${index};`).join('\n');
  const full=highlight({language:'javascript',mode:'source',text});assert.equal(full.status,'colored');
  assert.equal(syntaxRenderWithinLimit(full.lines),false);
  assert.equal(syntaxRenderWithinLimit(full.lines.slice(0,200)),true);
  const dense=highlight({language:'javascript',mode:'source',text:'const a=1;'.repeat(500)});
  assert.equal(dense.status,'colored');assert.equal(syntaxRenderWithinLimit(dense.lines),false);
  assert.equal(full.lines.map(line=>line.map(token=>token.text).join('')).join('\n'),text);
});

test('worker timeout is bounded and late replies/errors cannot take over a later request',async()=>{
  const workers=[],timers=new Map();let serial=0;
  const client=createSyntaxClient({available:()=>true,createWorker:()=>{const worker={messages:[],postMessage(message){this.messages.push(message);},terminate(){this.stopped=true;}};workers.push(worker);return worker;},
    schedule:callback=>{const id=++serial;timers.set(id,callback);return id;},cancel:id=>timers.delete(id)});
  const first=client('a.js',{mode:'source',text:'const a=1;'}),second=client('b.py',{mode:'source',text:'x=2'});
  assert.equal(workers.length,1);const old=workers[0],oldMessage=old.messages[0];timers.get(1)();
  assert.equal((await first).reason,'timeout');assert.equal(old.stopped,true);assert.equal(workers.length,2);
  old.onmessage({data:{id:oldMessage.id,result:{status:'colored',lines:[]}}});old.onerror();
  assert.equal(workers[1].stopped,undefined);
  const message=workers[1].messages[0];workers[1].onmessage({data:{id:message.id,result:highlight(message)}});
  assert.equal((await second).status,'colored');assert.equal(timers.size,0);
});

test('every syntax foreground retains at least 4.5:1 contrast on every supported code background',async()=>{
  const css=await readFile(new URL('../public/syntax.css',import.meta.url),'utf8');
  const colors=[...css.matchAll(/\.syntax-token-[a-z]+\{color:(#[a-f0-9]{6})\}/g)].map(match=>match[1]);assert.equal(colors.length,8);
  const theme=await readFile(new URL('../public/styles.css',import.meta.url),'utf8'),reviewer=await readFile(new URL('../public/reviewer.css',import.meta.url),'utf8');
  const backgrounds=[...['bg','add-bg','delete-bg'].map(name=>theme.match(new RegExp('--worn-diff-'+name+':\\s*(#[a-f0-9]{6})'))[1]),reviewer.match(/pre\{[^}]*background:(#[a-f0-9]{6})/)[1]];
  const brightness=hex=>{const c=hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
  for(const color of colors)for(const background of backgrounds){
    const ratio=(Math.max(brightness(color),brightness(background))+.05)/(Math.min(brightness(color),brightness(background))+.05);
    assert.ok(ratio>=4.5,`${color} against ${background}: ${ratio}`);
  }
});
