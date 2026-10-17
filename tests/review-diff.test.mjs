import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedDiff, diffWindow, DIFF_PAGE_LINES} from '../public/review-diff.js';
import {createDiffView} from '../public/ui/diff-view.js';
import {installFakeDOM} from './helpers/fake-dom.mjs';

const patch=(path,lines)=>`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n`+Array.from({length:lines},(_,i)=>`+value_${i} = ${i}`).join('\n')+'\n';
const nodes=node=>[node,...node.children.flatMap(nodes)];

test('file sections distinguish body additions from metadata, handle Git quoting, deletion and metadata-only changes',()=>{
  const diff='diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n--- "a/caf\\303\\251.py"\n+++ "b/caf\\303\\251.py"\n@@ -1 +1 @@\n--- source code\n+++ source code\n'
    +'diff --git a/old file.py b/old file.py\n--- a/old file.py\t\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n'
    +'diff --git a/tool.py b/tool.py\nold mode 100644\nnew mode 100755\n';
  const model=recordedDiff(diff,['café.py','old file.py','tool.py']);
  assert.equal(model.unmapped,0);assert.deepEqual(model.sections.map(x=>x.path),['café.py','old file.py','tool.py']);
  assert.deepEqual(model.sections.map(x=>[x.added,x.removed]),[[1,1],[0,1],[0,0]]);
  assert.equal(model.sections[0].rows.at(-1).kind,'addition');
});

test('unrecognized retained patch text is preserved without borrowing an unrelated filename',()=>{
  const model=recordedDiff('diff --git a/unknown.py b/unknown.py\n@@ -1 +1 @@\n-before\n+after\n',['known.py']);
  assert.equal(model.unmapped,1);assert.equal(model.sections[0].path,null);
  assert.deepEqual(model.missingPaths,['known.py']);
  assert.equal(model.sections[0].rows.at(-1).text,'+after');
});

test('all lines remain reachable through bounded windows, including a final partial window',()=>{
  const section=recordedDiff(patch('large.py',2000),['large.py']).sections[0];
  const visited=[];let offset=0;
  do{const page=diffWindow(section,offset);assert.ok(page.rows.length<=DIFF_PAGE_LINES);visited.push(...page.rows);offset=page.end;}while(offset<section.rows.length);
  assert.deepEqual(visited,section.rows);
  assert.equal(diffWindow(section,2000).end,section.rows.length);
});

test('20-file view renders only the selected section and preserves selection within the same commit',async()=>{
  installFakeDOM();const workspace={id:'one'};
  const paths=Array.from({length:20},(_,i)=>`src/part_${i}.py`);
  const run={id:'run',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),label:'Scale fixture',changedFiles:paths,diff:paths.map(path=>patch(path,100)).join('')};
  const view=createDiffView({getContext:()=>({workspace})});
  let panel=view(run);
  assert.equal(nodes(panel).filter(node=>node.className==='diff-file-button').length,20);
  assert.ok(nodes(panel).filter(node=>node.className?.startsWith('diff-line ')).length<=200);
  const files=nodes(panel).find(node=>node.className?.includes('diff-files-toggle'));
  await files.dispatch('click');assert.equal(files.attrs['aria-expanded'],'true');
  await nodes(panel).filter(node=>node.className==='diff-file-button')[19].dispatch('click');
  assert.equal(files.attrs['aria-expanded'],'false');
  assert.equal(panel.querySelector('h3').textContent,paths[19]);
  panel=view({...run});assert.equal(panel.querySelector('h3').textContent,paths[19]);
  panel=view({...run,headCommit:'c'.repeat(40)});assert.equal(panel.querySelector('h3').textContent,paths[0]);
  workspace.id='two';panel=view(run);assert.equal(panel.querySelector('h3').textContent,paths[0]);
});

test('a single large file pages and jumps without rendering the entire patch',async()=>{
  installFakeDOM();const run={id:'large',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),changedFiles:['large.py'],diff:patch('large.py',2000)};
  const panel=createDiffView({getContext:()=>({workspace:{id:'one'}})})(run);
  assert.equal(nodes(panel).filter(node=>node.className?.startsWith('diff-line ')).length,200);
  await nodes(panel).find(node=>node.tagName==='BUTTON'&&node.textContent==='Next lines').dispatch('click');
  assert.match(panel.textContent,/Diff lines 201–400 of 2004/);
  const input=nodes(panel).find(node=>node.attrs['aria-describedby']);input.value='1999';
  await nodes(panel).find(node=>node.tagName==='BUTTON'&&node.textContent==='Go').dispatch('click');
  assert.match(panel.textContent,/Diff lines 1999–2004 of 2004/);
  assert.equal(nodes(panel).filter(node=>node.className?.startsWith('diff-line ')).length,6);
});

test('diff jump controls cannot own or submit a surrounding decision form',async()=>{
  installFakeDOM();const run={id:'compare',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),changedFiles:['large.py'],diff:patch('large.py',500)};
  const panel=createDiffView({getContext:()=>({workspace:{id:'one'}})})(run);
  assert.equal(panel.querySelector('form'),null);
  const jump=nodes(panel).find(node=>node.attrs['aria-describedby']);
  assert.equal(jump.attrs.type,'text');assert.equal(jump.attrs.required,undefined);assert.equal(jump.attrs.pattern,undefined);
  assert.equal(nodes(panel).find(node=>node.tagName==='BUTTON'&&node.textContent==='Go').attrs.type,'button');
  let filterPrevented=false,filterStopped=false;
  await nodes(panel).find(node=>node.attrs.type==='search').dispatch('keydown',{key:'Enter',preventDefault(){filterPrevented=true;},stopPropagation(){filterStopped=true;}});
  assert.ok(filterPrevented&&filterStopped);
  let prevented=false,stopped=false;jump.value='301';
  await jump.dispatch('keydown',{key:'Enter',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented&&stopped);assert.match(panel.textContent,/Diff lines 301–500 of 504/);
  const invalid=nodes(panel).find(node=>node.attrs['aria-describedby']);invalid.value='99999';
  await nodes(panel).find(node=>node.tagName==='BUTTON'&&node.textContent==='Go').dispatch('click');
  assert.match(panel.textContent,/Enter a diff line from 1 to 504/);
  assert.equal(invalid.attrs['aria-invalid'],'true');assert.equal(invalid.attrs.required,undefined);
});

test('syntax toggle preserves visible diff text, line totals, scroll and keyboard focus',async()=>{
  const {document}=installFakeDOM();const run={id:'syntax',baseCommit:'a'.repeat(40),headCommit:'b'.repeat(40),changedFiles:['app.py'],diff:patch('app.py',500)};
  const panel=createDiffView({getContext:()=>({workspace:{id:'one'}})})(run);
  const before=panel.querySelector('pre');before.scrollTop=140;before.scrollLeft=90;
  const text=before.textContent;
  let button=nodes(panel).find(node=>node.className==='syntax-toggle');assert.equal(button.attrs.type,'button');
  await button.dispatch('click');const after=panel.querySelector('pre');
  assert.equal(after.textContent,text);assert.equal(after.scrollTop,140);assert.equal(after.scrollLeft,90);
  assert.match(panel.textContent,/Diff lines 1–200 of 504/);
  button=nodes(panel).find(node=>node.className==='syntax-toggle');assert.equal(button.attrs['aria-pressed'],'false');assert.equal(document.activeElement,button);
});
