import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { requiredOptions } from '../src/local/cli-input.mjs';
import { HostedAgentClient, loadHostedConnection } from '../src/local/hosted-agent-client.mjs';
import { createHostedMcpServer } from '../src/local/hosted-mcp.mjs';

let client;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.error('Projects Git hosted builder MCP (SDK v2)\n\nnode scripts/agent-mcp.mjs --connection <absolute-private-connection.json>\n\nStdio only. Configure the coding host to launch node directly. Credentials stay in the existing private connection file. No owner/reviewer tools or automatic retries. See docs/mcp.md.');
  } else {
    const options = requiredOptions(args, ['connection']);
    client = new HostedAgentClient(await loadHostedConnection(options.connection));
    const handle = serveStdio(() => createHostedMcpServer(client), {
      transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 }),
      onerror: () => console.error('Projects Git MCP transport error. Inspect the host connection and retained receipts before retrying work.'),
    });
    const close = () => { void handle.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
} catch (error) {
  console.error(client ? client.sanitize(error.message) : 'Projects Git MCP startup refused: ' + error.message);
  process.exitCode = 1;
}
