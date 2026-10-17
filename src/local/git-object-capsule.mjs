import {mkdir,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import {readOnlyGit} from './git-reader.mjs';

const MAGIC=Buffer.from('ProjectsGitObjects\0v1\n'),types=['','commit','tree','blob'];
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const refuse=message=>{throw Error('Git recovery objects: '+message);};
const header=(type,size)=>Buffer.from(type+' '+size+'\0');
function charge(budget,bytes,objects=1){
  if(!Number.isSafeInteger(bytes)||bytes<0||bytes>budget.remainingBytes||objects>budget.remainingObjects)refuse('Aggregate expanded-byte or object-count allowance exceeded.');
  budget.remainingBytes-=bytes;budget.remainingObjects-=objects;
}
function archiveCharge(budget,bytes){
  if(bytes>budget.remainingArchiveBytes)refuse('Aggregate encoded-byte allowance exceeded.');budget.remainingArchiveBytes-=bytes;
}
function references(type,bytes,limit){
  if(type==='blob')return [];
  if(type==='commit'){
    const end=bytes.indexOf('\n\n');if(end<0)refuse('Commit header is incomplete.');
    const lines=bytes.subarray(0,end).toString('latin1').split('\n');
    if(!/^tree [a-f0-9]{40}$/.test(lines[0])||lines.filter(line=>line.startsWith('tree ')).length!==1)refuse('Commit tree identity is malformed.');
    const roots=new Map([[lines[0].slice(5),'tree']]);
    for(const line of lines)if(line.startsWith('parent ')){
      if(!/^parent [a-f0-9]{40}$/.test(line))refuse('Commit parent identity is malformed.');
      if(roots.get(line.slice(7))==='tree')refuse('Conflicting Git reference type.');roots.set(line.slice(7),'commit');
      if(roots.size>limit)refuse('Git references exceed the available object inventory.');
    }
    return [...roots];
  }
  const roots=new Map();let offset=0;
  while(offset<bytes.length){
    const space=bytes.indexOf(32,offset),zero=bytes.indexOf(0,space+1);
    if(space<offset||zero<=space+1||zero+21>bytes.length)refuse('Tree entry is incomplete.');
    const mode=bytes.subarray(offset,space).toString('ascii'),name=bytes.subarray(space+1,zero);
    if(!['40000','040000','100644','100755','120000','160000'].includes(mode)||name.includes(47))refuse('Tree entry mode or name is malformed.');
    const hash=bytes.subarray(zero+1,zero+21).toString('hex');
    // Gitlinks retain their exact external commit identity in the tree. A
    // submodule repository must be a separately included recovery resource.
    if(mode!=='160000'){
      const type=mode==='40000'||mode==='040000'?'tree':'blob';
      if(roots.has(hash)&&roots.get(hash)!==type)refuse('Conflicting Git reference type.');roots.set(hash,type);
      if(roots.size>limit)refuse('Git references exceed the available object inventory.');
    }
    offset=zero+21;
  }
  return [...roots];
}
function validateGraph(objects,roots){
  const pending=roots.map(hash=>[hash,'commit']),seen=new Set();
  while(pending.length){
    const [hash,type]=pending.pop(),object=objects.get(hash);
    if(!oid(hash)||!object||object.type!==type)refuse('A required Git object is missing or has a different type.');
    if(seen.has(hash))continue;seen.add(hash);for(const reference of references(type,object.bytes,objects.size))pending.push(reference);
  }
  if(seen.size!==objects.size)refuse('Object inventory contains unrelated objects.');
}

/** Dedicated offline walker. It never applies submission tree or ancestry caps. */
export async function captureGitObjects(roots,sources,budget){
  const objects=new Map(),pending=roots.map(hash=>[hash,'commit',sources[hash]]),segments=[MAGIC,Buffer.alloc(4)];
  archiveCharge(budget,MAGIC.length+4);
  while(pending.length){
    const [hash,type,source]=pending.pop();if(!oid(hash)||!types.includes(type))refuse('Unsupported requested Git object.');
    if(objects.has(hash)){if(objects.get(hash).type!==type)refuse('Conflicting Git object type.');continue;}
    if(budget.remainingObjects<1)refuse('Aggregate object-count allowance exceeded.');
    const git=readOnlyGit(source),metadata=await git(['cat-file','--batch-check'],{input:hash+'\n',maxBuffer:256});
    const match=/^([a-f0-9]{40}) (commit|tree|blob) ([0-9]+)\n$/.exec(metadata);
    if(!match||match[1]!==hash||match[2]!==type)refuse('Source Git object is missing or has a different type.');
    const size=Number(match[3]),prefix=header(type,size);
    if(!Number.isSafeInteger(size)||size<0||size+prefix.length>budget.remainingBytes)refuse('Aggregate expanded-byte allowance exceeded.');
    const bytes=await git(['cat-file',type,hash],{binary:true,maxBuffer:Math.max(1,size+1)});
    if(bytes.length!==size)refuse('Source object length changed during capture.');
    const loose=Buffer.concat([prefix,bytes]);if(createHash('sha1').update(loose).digest('hex')!==hash)refuse('Source object identity changed during capture.');
    const compressed=deflateSync(loose),frame=Buffer.alloc(29);frame[0]=types.indexOf(type);Buffer.from(hash,'hex').copy(frame,1);
    frame.writeUInt32BE(size,21);frame.writeUInt32BE(compressed.length,25);
    charge(budget,loose.length);archiveCharge(budget,frame.length+compressed.length);segments.push(frame,compressed);
    objects.set(hash,{type,bytes,compressed});
    for(const [child,childType] of references(type,bytes,budget.remainingObjects+objects.size))pending.push([child,childType,source]);
  }
  validateGraph(objects,roots);segments[1].writeUInt32BE(objects.size);
  return Buffer.concat(segments);
}

/** Validate the exact untrusted bytes, expanded sizes and closure before any restore directory is created. */
export function readGitObjects(bytes,roots,budget){
  if(!Buffer.isBuffer(bytes)||bytes.length<MAGIC.length+4||!bytes.subarray(0,MAGIC.length).equals(MAGIC))refuse('Unsupported Git object capsule.');
  archiveCharge(budget,bytes.length);
  const total=bytes.readUInt32BE(MAGIC.length),objects=new Map();let offset=MAGIC.length+4;
  if(total>budget.remainingObjects)refuse('Aggregate object-count allowance exceeded.');
  for(let index=0;index<total;index++){
    if(offset+29>bytes.length)refuse('Object capsule header is incomplete.');
    const type=types[bytes[offset]],hash=bytes.subarray(offset+1,offset+21).toString('hex'),size=bytes.readUInt32BE(offset+21),compressedSize=bytes.readUInt32BE(offset+25);offset+=29;
    if(!type||objects.has(hash)||compressedSize<1||offset+compressedSize>bytes.length)refuse('Invalid or duplicate object frame.');
    const prefix=header(type,size),expanded=prefix.length+size;
    if(expanded>budget.remainingBytes)refuse('Aggregate expanded-byte allowance exceeded.');
    const compressed=bytes.subarray(offset,offset+compressedSize);let decoded;
    try{decoded=inflateSync(compressed,{maxOutputLength:expanded,info:true});}catch{refuse('Compressed object is corrupt or exceeds its expanded-byte allowance.');}
    const loose=decoded.buffer;
    if(decoded.engine.bytesWritten!==compressedSize||loose.length!==expanded||!loose.subarray(0,prefix.length).equals(prefix)
      ||createHash('sha1').update(loose).digest('hex')!==hash)refuse('Expanded object length, framing or identity differs.');
    charge(budget,expanded);objects.set(hash,{type,bytes:loose.subarray(prefix.length),compressed});offset+=compressedSize;
  }
  if(offset!==bytes.length)refuse('Object capsule contains trailing data.');
  validateGraph(objects,roots);return objects;
}

export async function installGitObjects(objects,destination){
  if(await realpath(destination)!==destination)refuse('Git recovery destination was redirected.');
  for(const [hash,object] of objects){
    const folder=path.join(destination,'objects',hash.slice(0,2));await mkdir(folder,{recursive:true});
    if(await realpath(folder)!==folder)refuse('Git recovery object directory was redirected.');
    await writeFile(path.join(folder,hash.slice(2)),object.compressed,{flag:'wx',mode:0o600});
  }
}
