import {readFile,lstat} from 'node:fs/promises';
import {writeWorkspaceBundle,restoreWorkspaceBundle} from '../src/local/workspace-bundle.mjs';
import {MAX_WORKSPACE_BACKUP_BYTES,WORKSPACE_BACKUP_MIB} from '../public/workspace-backup-limits.js';
async function readJson(file){
  const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_WORKSPACE_BACKUP_BYTES)throw Error(`Input must be a regular JSON file no larger than ${WORKSPACE_BACKUP_MIB} MiB.`);
  const bytes=await readFile(file);if(bytes.length>MAX_WORKSPACE_BACKUP_BYTES)throw Error(`Input grew beyond ${WORKSPACE_BACKUP_MIB} MiB.`);
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
const [action,...args]=process.argv.slice(2);let receipt;
if(action==='export'&&args.length===4){
  const [archiveFile,expectedArchiveSha256,sourcesFile,directory]=args;
  receipt=await writeWorkspaceBundle({archive:await readJson(archiveFile),expectedArchiveSha256,
    sources:await readJson(sourcesFile),directory});
}else if(action==='restore'&&args.length===4){
  const [directory,expectedManifestSha256,expectedSourceWorkspaceId,destination]=args;
  receipt=await restoreWorkspaceBundle({directory,expectedManifestSha256,expectedSourceWorkspaceId,destination});
}else throw Error('Usage: workspace-bundle.mjs export <workspace.json> <expected-archive-sha256> <local-sources.json> <new-package-directory> OR restore <package-directory> <expected-manifest-sha256> <expected-source-workspace-id> <new-recovery-directory>');
console.log(JSON.stringify(receipt,null,2));
