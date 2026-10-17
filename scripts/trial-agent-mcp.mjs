import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {requiredOptions} from '../src/local/cli-input.mjs';
import {loadTrialConnection,TrialAgentClient} from '../src/local/trial-agent-client.mjs';
import {createTrialMcpServer} from '../src/local/trial-mcp.mjs';
let client;
try {
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help')console.error('Projects Git trial MCP\nnode scripts/trial-agent-mcp.mjs --connection <absolute-private-connection.json>\nUse separate agent and reviewer connections. No owner actions, raw Git credentials, model calls or automatic retries.');
  else {
    const options=requiredOptions(args,['connection']);client=new TrialAgentClient(await loadTrialConnection(options.connection));
    const handle=serveStdio(()=>createTrialMcpServer(client),{transport:new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:128*1024}),onerror:()=>console.error('Trial MCP transport failed. Inspect current status before retrying.')});
    const close=()=>{void handle.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',close);process.once('SIGTERM',close);
  }
}catch(error){console.error(client?client.sanitize(error.message):'Trial connection could not open. Check the absolute private connection file.');process.exitCode=1;}
