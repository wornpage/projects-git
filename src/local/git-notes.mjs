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
async function existingNote(git,ref,commit) {
  const result=await git(['notes','--ref='+ref,'list',commit],{codes:[0,1]});
  if(result.code===1)return null;
  const blob=commitId(result.text.trim());
  const size=Number((await git(['cat-file','-s',blob])).text.trim());
  if(!Number.isSafeInteger(size)||size>MAX_GIT_NOTE_BYTES)throw new Error('Existing Git context exceeds 32 KiB; it was not changed.');
  const body=(await git(['cat-file','blob',blob])).text;
  await readGitNote(body,commit);
  return body;
}

export async function showGitNote(directory,commit) {
  commitId(commit);const git=await repository(directory);
  if((await git(['cat-file','-t',commit])).text.trim()!=='commit')throw new Error('The selected object is not a commit.');
  const head=await refHead(git,GIT_NOTES_REF),body=head?await existingNote(git,GIT_NOTES_REF,commit):null;
  return {ref:GIT_NOTES_REF,notesHead:head,commit,status:body===null?'absent':'recorded',
    boundary:'Untrusted recorded context; refresh the authenticated workspace before acting.',
    note:body===null?null:await readGitNote(body,commit)};
}

export async function writeGitNote(directory,input) {
  const note=await readGitNote(input),git=await repository(directory);
  if(await refHead(git,'NOTES_MERGE_PARTIAL'))throw new Error('Finish or abort the pending Git notes merge before appending context.');
  if((await git(['cat-file','-t',note.commit])).text.trim()!=='commit')throw new Error('The selected object is not a commit.');
  const previous=await refHead(git,GIT_NOTES_REF),temporary='refs/notes/projects-pending/'+randomUUID();
  let temporaryHead;
  try{
    if(previous){await git(['update-ref',temporary,previous,zero]);temporaryHead=previous;}
    const existing=previous?await existingNote(git,temporary,note.commit):null;
    const merged=await mergeGitNotes(existing,input),body=serializeGitNote(merged);
    if(existing!==null&&serializeGitNote(await readGitNote(existing,note.commit))===body)
      return {ref:GIT_NOTES_REF,commit:note.commit,notesHead:previous,records:merged.records.length,changed:false};
    await git(['notes','--ref='+temporary,'add','-f','-F','-',note.commit],{input:body});
    temporaryHead=await refHead(git,temporary);
    // Publish only if the notes ref still has the head used to build this append.
    const update=await git(['update-ref',GIT_NOTES_REF,temporaryHead,previous??zero],{codes:[0,128]});
    if(update.code!==0){
      if(await refHead(git,GIT_NOTES_REF)!==previous)throw new Error('Git context changed concurrently. Read the current notes and retry explicitly; no existing note was overwritten.');
      throw new Error('Git refused the notes ref update. Inspect repository permissions and locks before retrying.');
    }
    return {ref:GIT_NOTES_REF,commit:note.commit,notesHead:temporaryHead,records:merged.records.length,changed:true};
  } finally {
    temporaryHead ??= await refHead(git,temporary);
    if(temporaryHead)await git(['update-ref','-d',temporary,temporaryHead]);
  }
}
