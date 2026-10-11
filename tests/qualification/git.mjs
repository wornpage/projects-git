import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
export function git(args,cwd,credentials){
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC)$/i.test(key))),
    GIT_TERMINAL_PROMPT:'0',GIT_TRACE:'0',GIT_TRACE_CURL:'0',GIT_CURL_VERBOSE:'0',GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
  if(credentials){env.ARTIFACTS_GIT_REMOTE=credentials.remote;env.ARTIFACTS_GIT_TOKEN=credentials.token;}
  const helper=resolve('tests/qualification/credential-helper.mjs').replaceAll('\\','/'),node=process.execPath.replaceAll('\\','/');
  const controls=['-c','credential.helper=','-c',`credential.helper=!"${node}" "${helper}"`,'-c','credential.useHttpPath=true','-c','http.followRedirects=false','-c','http.extraHeader=','-c','core.hooksPath='+resolve('qa/identity-concurrency/empty-hooks')];
  return new Promise((accept,reject)=>{const child=spawn('git',[...controls,...args],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',error='';
    const timer=setTimeout(()=>child.kill(),90000);child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>error+=part);
    child.on('error',()=>{clearTimeout(timer);reject(Error('Git could not start'));});
    child.on('close',code=>{clearTimeout(timer);if(code===0)accept(output.trim());else{for(const value of [credentials?.token,credentials?.token?.split('?')[0]])if(value)error=error.replaceAll(value,'[redacted]');reject(Error('Git failed: '+error.slice(0,1200)));}});
  });
}
