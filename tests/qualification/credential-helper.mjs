// Git consumes this stdout directly; never invoke the helper as a log command.
if(process.argv.at(-1)!=='get')process.exit(0);
let input='';for await(const part of process.stdin){input+=part;if(input.length>4096)process.exit(1);}
const fields=Object.fromEntries(input.trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
const remote=new URL(process.env.ARTIFACTS_GIT_REMOTE);
if(fields.protocol!=='https'||fields.host!==remote.host||fields.path!==remote.pathname.slice(1))process.exit(1);
const secret=process.env.ARTIFACTS_GIT_TOKEN?.split('?')[0];if(!secret||/[\r\n]/.test(secret))process.exit(1);
process.stdout.write(`username=x\npassword=${secret}\n\n`);
