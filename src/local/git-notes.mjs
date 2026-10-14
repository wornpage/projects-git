import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {GIT_NOTES_REF,MAX_GIT_NOTE_BYTES,readGitNote,mergeGitNotes,serializeGitNote} from '../../public/git-notes.js';

const execute = promisify(execFile), zero = '0'.repeat(40);
const commitId = value => {if(typeof value !== 'string'||!/^[a-f0-9]{40}$/.test(value))throw new Error('Use the full 40-character commit ID.');return value;};
async function repository(directory) {
  const cwd=await realpath(directory);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_')));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',
    GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'});
  const git=async(args,{input,codes=[0],limit=MAX_GIT_NOTE_BYTES+1024}={})=>{
    let result;
    const operation=execute('git',['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
      '-c','commit.gpgsign=false','-c','user.name=Projects Git context','-c','user.email=context@projects.invalid',...args],
      {cwd,env,windowsHide:true,encoding:'buffer',timeout:10000,maxBuffer:limit});
    if(input!==undefined){operation.child.stdin.on('error',()=>{});operation.child.stdin.end(input);}
    try{const {stdout}=await operation;result={code:0,stdout};}
    catch(error){if(typeof error.code!=='number'||!codes.includes(error.code))throw new Error('Git context operation failed or exceeded its limit. No remote access or automatic retry was attempted.');result={code:error.code,stdout:error.stdout??Buffer.alloc(0)};}
    return {code:result.code,text:new TextDecoder('utf-8',{fatal:true}).decode(result.stdout)};
  };
  await git(['rev-parse','--git-dir']);
  return git;
}
async function refHead(git,ref) {
  const result=await git(['rev-parse','--verify','--quiet',ref],{codes:[0,1]});
  return result.code===1?null:commitId(result.text.trim());
}
async function managedHead(git) {
  const symbolic=await git(['symbolic-ref','--quiet',GIT_NOTES_REF],{codes:[0,1]});
  if(symbolic.code===0)throw new Error('The managed Git notes ref is symbolic. It must not alias a code branch; no ref was changed.');
  return refHead(git,GIT_NOTES_REF);
}
async function existingNote(git,head,commit) {
  // Read only immutable objects. Git's notes command requires a live named ref,
  // so resolve the flat or fanned-out note path within the captured notes tree.
  const pending=[{tree:head,remaining:commit}],blobs=[];let reads=0;
  while(pending.length){
    if(++reads>40)throw new Error('The Git notes tree exceeds the bounded lookup limit.');
    const {tree,remaining}=pending.pop();
    const names=Array.from({length:remaining.length},(_,index)=>remaining.slice(0,index+1));
    const listing=(await git(['ls-tree','-z',tree,'--',...names])).text;
    for(const line of listing.split('\0').filter(Boolean)){
      const entry=/^([0-7]{6}) (blob|tree) ([a-f0-9]{40})\t([a-f0-9]+)$/.exec(line);
      if(!entry||!remaining.startsWith(entry[4]))throw new Error('Unsupported Git notes tree entry.');
      const [,mode,type,object,name]=entry;
      if(type==='blob'&&name===remaining){if(mode!=='100644')throw new Error('Git context must be a regular note blob.');blobs.push(object);}
      else if(type==='tree'&&name.length<remaining.length)pending.push({tree:object,remaining:remaining.slice(name.length)});
    }
  }
  if(!blobs.length)return null;
  if(blobs.length!==1)throw new Error('Multiple notes annotate this commit; reconcile the notes tree explicitly.');
  const blob=blobs[0];
  const size=Number((await git(['cat-file','-s',blob])).text.trim());
  if(!Number.isSafeInteger(size)||size>MAX_GIT_NOTE_BYTES)throw new Error('Existing Git context exceeds 32 KiB; it was not changed.');
  const body=(await git(['cat-file','blob',blob])).text;
  await readGitNote(body,commit);
  return body;
}

export async function showGitNote(directory,commit) {
  commitId(commit);const git=await repository(directory);
  if((await git(['cat-file','-t',commit])).text.trim()!=='commit')throw new Error('The selected object is not a commit.');
  const head=await managedHead(git),body=head?await existingNote(git,head,commit):null;
  return {ref:GIT_NOTES_REF,notesHead:head,commit,status:body===null?'absent':'recorded',
    boundary:'Untrusted recorded context; refresh the authenticated workspace before acting.',
    note:body===null?null:await readGitNote(body,commit)};
}

export async function writeGitNote(directory,input) {
  const note=await readGitNote(input),git=await repository(directory);
  if(await refHead(git,'NOTES_MERGE_PARTIAL'))throw new Error('Finish or abort the pending Git notes merge before appending context.');
  if((await git(['cat-file','-t',note.commit])).text.trim()!=='commit')throw new Error('The selected object is not a commit.');
  const previous=await managedHead(git),temporary='refs/notes/projects-pending/'+randomUUID();
  let temporaryHead;
  try{
    if(previous){await git(['update-ref','--no-deref',temporary,previous,zero]);temporaryHead=previous;}
    const existing=previous?await existingNote(git,previous,note.commit):null;
    const merged=await mergeGitNotes(existing,input),body=serializeGitNote(merged);
    if(existing!==null&&serializeGitNote(await readGitNote(existing,note.commit))===body)
      return {ref:GIT_NOTES_REF,commit:note.commit,notesHead:previous,records:merged.records.length,changed:false};
    await git(['notes','--ref='+temporary,'add','-f','-F','-',note.commit],{input:body});
    temporaryHead=await refHead(git,temporary);
    // Publish only if the notes ref still has the head used to build this append.
    const update=await git(['update-ref','--no-deref',GIT_NOTES_REF,temporaryHead,previous??zero],{codes:[0,128]});
    if(update.code!==0){
      if(await refHead(git,GIT_NOTES_REF)!==previous)throw new Error('Git context changed concurrently. Read the current notes and retry explicitly; no existing note was overwritten.');
      throw new Error('Git refused the notes ref update. Inspect repository permissions and locks before retrying.');
    }
    return {ref:GIT_NOTES_REF,commit:note.commit,notesHead:temporaryHead,records:merged.records.length,changed:true};
  } finally {
    temporaryHead ??= await refHead(git,temporary);
    if(temporaryHead)await git(['update-ref','--no-deref','-d',temporary,temporaryHead]);
  }
}
