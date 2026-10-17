import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceStore} from '../src/cloudflare/workspace-store.ts';
import {ArtifactEventReceipts} from '../src/cloudflare/artifact-events.ts';
import {ArtifactSubscriptions} from '../src/cloudflare/artifact-subscriptions.ts';
import {buildWorkspaceBackup,workspaceBackupPreview} from '../src/core/workspace-backup.mjs';
import {sqliteStorage} from './helpers/sqlite-store.mjs';

const subscriptionAttempt='20000000-0000-4000-8000-000000000002',eventAttempt='30000000-0000-4000-8000-000000000003',completeAttempt='40000000-0000-4000-8000-000000000004',eventKey='e'.repeat(64),completeKey='c'.repeat(64);
function populate(storage){
  new ArtifactEventReceipts(storage);new ArtifactSubscriptions(storage);
  storage.sql.exec('INSERT INTO artifact_subscriptions(repository,fingerprint,plan,phase,attempt_id) VALUES (?,?,?,?,?)',
    'private-repository','f'.repeat(64),JSON.stringify({ownerKey:'SECRET_OWNER_KEY',accountId:'SECRET_ACCOUNT'}),'creating',subscriptionAttempt);
  storage.sql.exec('INSERT INTO artifact_subscription_attempts(id,repository,started_at,status) VALUES (?,?,?,?)',
    subscriptionAttempt,'private-repository','2026-10-16T10:00:00.000Z','pending');
  const event={accountId:'SECRET_ACCOUNT',subscriptionId:'abcdef0123456789',namespace:'SECRET_NAMESPACE',repositoryName:'private-repository',
    ref:'refs/heads/main',before:'a'.repeat(40),after:'b'.repeat(40),timestamp:'2026-10-16T10:01:00Z'};
  storage.sql.exec('INSERT INTO artifact_events(event_key,event,status,attempt_id) VALUES (?,?,?,?)',eventKey,JSON.stringify(event),'pending',eventAttempt);
  storage.sql.exec('INSERT INTO artifact_event_attempts(attempt_id,event_key,started_at,status) VALUES (?,?,?,?)',
    eventAttempt,eventKey,'2026-10-16T10:01:01.000Z','pending');
  storage.sql.exec('INSERT INTO artifact_deliveries(message_id,event_key) VALUES (?,?)','delivery:fixture',eventKey);
  const completeEvent={...event,after:'c'.repeat(40),timestamp:'2026-10-16T10:02:00Z'},result={key:completeKey,state:'observed',headCommit:'c'.repeat(40),repositoryName:'private-repository',ref:'refs/heads/main',runIds:[],projectIds:[]};
  storage.sql.exec('INSERT INTO artifact_events(event_key,event,status,attempt_id,result) VALUES (?,?,?,?,?)',completeKey,JSON.stringify(completeEvent),'complete',completeAttempt,JSON.stringify(result));
  storage.sql.exec('INSERT INTO artifact_event_attempts(attempt_id,event_key,started_at,finished_at,status) VALUES (?,?,?,?,?)',
    completeAttempt,completeKey,'2026-10-16T10:02:01.000Z','2026-10-16T10:02:02.000Z','complete');
  storage.sql.exec('INSERT INTO artifact_deliveries(message_id,event_key) VALUES (?,?)','delivery:complete',completeKey);
}

test('backup capture refuses missing coordinator ledger tables without creating them',t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'ledger-workspace');
  const before=storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'artifact_%' ORDER BY name").toArray();
  assert.throws(()=>store.captureBackup(),{code:'BACKUP_LEDGER_UNAVAILABLE'});
  assert.deepEqual(storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'artifact_%' ORDER BY name").toArray(),before);
});

test('one SQLite transaction captures secret-safe pending ledgers with complete denominators and no writes',async t=>{
  const {db,storage,queries}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'ledger-workspace');populate(storage);
  const start=queries.length,capture=store.captureBackup(),captureQueries=queries.slice(start);
  assert.ok(captureQueries.length>5);assert.ok(captureQueries.every(query=>/^SELECT\b/.test(query.sql)));
  assert.equal(capture.backupLedgers.capture,'coherent-sqlite-transaction');
  assert.deepEqual(capture.backupLedgers.artifactSubscriptions[0],{repositoryName:'private-repository',fingerprint:'f'.repeat(64),phase:'creating',subscriptionId:null,attemptId:subscriptionAttempt});
  assert.equal(capture.backupLedgers.artifactEvents[0].event.repositoryName,'private-repository');assert.equal(capture.backupLedgers.artifactEvents.find(row=>row.eventKey===completeKey).result.state,'observed');
  const exportedAt='2026-10-16T11:00:00.000Z',archive=await buildWorkspaceBackup(capture.snapshot,exportedAt,capture.backupLedgers),serialized=JSON.stringify(archive),counts=workspaceBackupPreview(archive).counts;
  assert.ok(!serialized.includes('SECRET_'));assert.equal(counts.artifactSubscriptions,1);assert.equal(counts.pendingArtifactSubscriptions,1);
  assert.equal(counts.creatingArtifactSubscriptions,1);assert.equal(counts.readyArtifactSubscriptions,0);
  assert.equal(counts.artifactSubscriptionAttempts,1);assert.equal(counts.pendingArtifactSubscriptionAttempts,1);
  assert.equal(counts.artifactEvents,2);assert.equal(counts.pendingArtifactEvents,1);assert.equal(counts.artifactEventAttempts,2);
  assert.equal(counts.completedArtifactEvents,1);assert.equal(counts.failedArtifactEvents,0);
  assert.equal(counts.pendingArtifactEventAttempts,1);assert.equal(counts.completedArtifactEventAttempts,1);assert.equal(counts.artifactDeliveries,2);
  storage.sql.exec('INSERT INTO artifact_deliveries(message_id,event_key) VALUES (?,?)','delivery:later',eventKey);
  const next=store.captureBackup(),nextArchive=await buildWorkspaceBackup(next.snapshot,exportedAt,next.backupLedgers);
  assert.equal(next.snapshot.revision,capture.snapshot.revision);assert.notEqual(nextArchive.sha256,archive.sha256);
  assert.equal(workspaceBackupPreview(nextArchive).counts.artifactDeliveries,3);
});

test('malformed retained event JSON fails capture instead of leaking or silently dropping fields',t=>{
  const {db,storage}=sqliteStorage();t.after(()=>db.close());const store=new WorkspaceStore(storage,'ledger-workspace');populate(storage);
  storage.sql.exec('UPDATE artifact_events SET event=? WHERE event_key=?',JSON.stringify({credential:'SECRET_TOKEN'}),eventKey);
  assert.throws(()=>store.captureBackup(),{code:'BACKUP_LEDGER_UNAVAILABLE'});
});
