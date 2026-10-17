import {DatabaseSync} from 'node:sqlite';
import {openSync,closeSync,writeFileSync,fsyncSync,renameSync,lstatSync,realpathSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const MAX_JOURNAL_ROWS=512;
const samePath=(left,right)=>(process.platform==='win32'?left.toLowerCase():left)===(process.platform==='win32'?right.toLowerCase():right);
const refuse=()=>{throw Error('Hosted delivery durable state is invalid. No remote write was authorized.');};
const json=value=>JSON.stringify(value);
function ordinary(file,limit){
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>limit||!samePath(realpathSync(file),file))refuse();
  const bytes=readFileSync(file);if(bytes.length>limit)refuse();return bytes.toString('utf8');
}
function fault(port,stage,transition){port?.({stage,transition});}
function project(file,value,port,transition){
  const temporary=file+'.'+randomUUID()+'.tmp',contents=json(value),fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,contents);fault(port,'before-projection-temp-sync',transition);fsyncSync(fd);fault(port,'after-projection-temp-sync',transition);}finally{closeSync(fd);}
  fault(port,'before-projection-rename',transition);renameSync(temporary,file);fault(port,'after-projection-rename',transition);
  const final=openSync(file,'r+');try{fsyncSync(final);}finally{closeSync(final);}fault(port,'after-projection-final-sync',transition);
  // SQLite FULL is the cross-platform durable authority. POSIX additionally
  // flushes this human-readable projection's directory entry; Windows does not
  // claim directory-fsync support and can reconstruct it from SQLite instead.
  fault(port,'before-projection-directory-sync',transition);if(process.platform!=='win32'){
    const parent=openSync(path.dirname(file),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  }
  fault(port,'after-projection-directory-sync',transition);
}
function database(file){
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||!samePath(realpathSync(file),file))refuse();
  const db=new DatabaseSync(file);db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
  if(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase()!=='delete'||Number(db.prepare('PRAGMA synchronous').get().synchronous)!==2){db.close();refuse();}return db;
}
function validateJournal(db,guard=()=>({}),validateTransition=()=>true){
  const state=db.prepare('SELECT version,sha256,data FROM delivery_state WHERE id=1').get();if(!state||!Number.isSafeInteger(state.version)||state.version<1||digest(state.data)!==state.sha256)refuse();
  const rows=db.prepare('SELECT sequence,previous_sha256,state_sha256,transition,guard FROM delivery_journal ORDER BY sequence').all();
  if(rows.length!==state.version||rows.length>MAX_JOURNAL_ROWS)refuse();let previous=null,previousGuard=null;
  for(const [index,row] of rows.entries()){
    if(row.sequence!==index+1||row.previous_sha256!==previous||!/^[a-f0-9]{64}$/.test(row.state_sha256)||typeof row.transition!=='string'||!/^[a-z-]{1,40}$/.test(row.transition))refuse();
    let currentGuard;try{currentGuard=JSON.parse(row.guard);}catch{return refuse();}
    if(previousGuard!==null&&!validateTransition(previousGuard,currentGuard,row.transition))refuse();
    previous=row.state_sha256;previousGuard=currentGuard;
  }
  if(previous!==state.sha256)return refuse();let value;try{value=JSON.parse(state.data);}catch{return refuse();}
  if(value.version!==state.version||json(guard(value))!==json(previousGuard))return refuse();return value;
}

export function createDeliveryState(directory,value,{storageFault,guard=()=>({})}={}){
  const file=path.join(directory,'delivery.sqlite'),projection=path.join(directory,'delivery.json'),fd=openSync(file,'wx',0o600);closeSync(fd);
  const db=database(file);try{
    db.exec('CREATE TABLE delivery_state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE delivery_journal(sequence INTEGER PRIMARY KEY,previous_sha256 TEXT,state_sha256 TEXT NOT NULL,transition TEXT NOT NULL,guard TEXT NOT NULL,at TEXT NOT NULL);');
    const data=json(value),sha256=digest(data);fault(storageFault,'before-state-commit','prepare');db.exec('BEGIN IMMEDIATE');
    try{db.prepare('INSERT INTO delivery_state(id,version,sha256,data) VALUES (1,?,?,?)').run(value.version,sha256,data);
      db.prepare('INSERT INTO delivery_journal(sequence,previous_sha256,state_sha256,transition,guard,at) VALUES (1,NULL,?,?,?,?)').run(sha256,'prepare',json(guard(value)),new Date().toISOString());db.exec('COMMIT');}
    catch(error){db.exec('ROLLBACK');throw error;}fault(storageFault,'after-state-commit','prepare');
  }finally{db.close();}
  project(projection,value,storageFault,'prepare');return value;
}

export function openDeliveryState(directory,{storageFault,guard=()=>({}),validateTransition=()=>true}={}){
  const file=path.join(directory,'delivery.sqlite'),projection=path.join(directory,'delivery.json');
  const read=()=>{const db=database(file);try{return validateJournal(db,guard,validateTransition);}finally{db.close();}};
  let current=read();
  let projected=null;try{projected=ordinary(projection,4*1024*1024);}catch{}
  const projectionRecovered=projected!==json(current);if(projectionRecovered)project(projection,current,storageFault,'repair-projection');
  return {projectionRecovered,read:()=>structuredClone(current),save(value,transition){
    const before=current,next=structuredClone(value);if(next.version!==before.version||before.version>=MAX_JOURNAL_ROWS||!validateTransition(guard(before),guard(next),transition))refuse();next.version=before.version+1;
    const data=json(next),sha256=digest(data),previous=digest(json(before));fault(storageFault,'before-state-commit',transition);
    const db=database(file);try{db.exec('BEGIN IMMEDIATE');try{
      const retained=validateJournal(db,guard,validateTransition);if(digest(json(retained))!==previous)refuse();
      db.prepare('UPDATE delivery_state SET version=?,sha256=?,data=? WHERE id=1 AND version=?').run(next.version,sha256,data,before.version);
      if(db.prepare('SELECT changes() AS n').get().n!==1)refuse();
      db.prepare('INSERT INTO delivery_journal(sequence,previous_sha256,state_sha256,transition,guard,at) VALUES (?,?,?,?,?,?)').run(next.version,previous,sha256,transition,json(guard(next)),new Date().toISOString());db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}}finally{db.close();}
    current=next;fault(storageFault,'after-state-commit',transition);project(projection,current,storageFault,transition);return structuredClone(current);
  }};
}
