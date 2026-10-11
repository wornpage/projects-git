import {WorkspaceStore} from '../../src/cloudflare/workspace-store.ts';
import {sqliteStorage} from './sqlite-store.mjs';

// Memory-backed controller fixtures use the canonical SQLite projection rather
// than duplicating its global capacity and history selection rules.
export function snapshotPage(snapshot,request){
  const {db,storage}=sqliteStorage();
  try{
    db.exec('CREATE TABLE snapshot (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)');
    db.prepare('INSERT INTO snapshot VALUES (1, ?, ?)').run(snapshot.revision,JSON.stringify(snapshot));
    return new WorkspaceStore(storage,snapshot.workspace.id).readPage(request);
  }finally{db.close();}
}
