import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createHostedMcpServer } from '../../src/local/hosted-mcp.mjs';

export async function connectMcp(t, hostedClient) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createHostedMcpServer(hostedClient), { transport: serverTransport });
  const protocol = new Client({ name: 'local-mcp-qualification', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  t.after(async () => { await protocol.close(); await handle.close(); });
  await protocol.connect(clientTransport);
  return { protocol, call: (name, args = {}, options) => protocol.callTool({ name: 'projects_git_' + name, arguments: args }, options) };
}
