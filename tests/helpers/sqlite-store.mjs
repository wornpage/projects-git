import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';

export function sqliteStorage(filename=':memory:') {
  const db=new DatabaseSync(filename),queries=[];
  const storage={sql:{exec(sql,...args){
    const rows=db.prepare(sql).all(...args).map(row=>({...row}));
    queries.push({sql,rows:rows.length,bytes:Buffer.byteLength(JSON.stringify(rows))});
    return {toArray:()=>rows,one(){assert.equal(rows.length,1);return rows[0];}};
  }},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}};
  return {db,storage,queries};
}
