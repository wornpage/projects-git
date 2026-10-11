import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const dir=resolve('qa/subscriptions-local');await mkdir(dir,{recursive:true});
const config={name:'projects-subscription-local',main:'../../tests/runtime/subscription-fixture.ts',compatibility_date:'2026-10-08',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,routes:[],
  vars:{WORKSPACE_ID:'subscription-local-'+Date.now(),ACCESS_TEAM_DOMAIN:'https://fixture.cloudflareaccess.com',ACCESS_AUD:'a'.repeat(64),ACCESS_OWNER_SUB:'fixture-owner',ACCESS_AGENT_CLIENT_IDS:JSON.stringify(['1'.repeat(32)+'.access']),ACCESS_REVIEWER_CLIENT_IDS:'[]',ACCESS_REVIEWER_SUBJECTS:'[]',
    ARTIFACTS_EVENTS_ACCOUNT_ID:'1'.repeat(32),ARTIFACTS_EVENTS_NAMESPACE:'fixture',ARTIFACTS_EVENTS_QUEUE:'subscription-events-local',ARTIFACTS_EVENTS_SUBSCRIPTIONS:'[]',ARTIFACTS_EVENTS_AUTOMATIC:'true',ARTIFACTS_EVENTS_QUEUE_ID:'2'.repeat(32)},
  durable_objects:{bindings:[{name:'WORKSPACES',class_name:'WorkspaceCoordinator'},{name:'SUBSCRIPTION_FIXTURE',class_name:'SubscriptionFixture'},{name:'FIXTURE_REPOS',class_name:'ArtifactsFixtureStore'}]},
  migrations:[{tag:'v1',new_sqlite_classes:['WorkspaceCoordinator','SubscriptionFixture','ArtifactsFixtureStore']}],
  services:[{binding:'ARTIFACTS',service:'projects-subscription-local',entrypoint:'ArtifactsFixture'}],
  queues:{producers:[{binding:'PUSHES',queue:'subscription-events-local'}],consumers:[{queue:'subscription-events-local',max_batch_size:1,max_batch_timeout:1,max_retries:3,retry_delay:1}]}};
const driver={name:'projects-subscription-local-driver',main:'../../tests/runtime/subscription-driver.ts',compatibility_date:'2026-10-08',workers_dev:false,preview_urls:false,routes:[],services:[{binding:'CONTROL',service:config.name,entrypoint:'SubscriptionQualificationControl'}]};
await writeFile(resolve(dir,'worker.json'),JSON.stringify(config,null,2));await writeFile(resolve(dir,'driver.json'),JSON.stringify(driver,null,2));
console.log('Prepared local-only Workerd/SQLite/service-binding qualifier with simulated owner and provider.');
