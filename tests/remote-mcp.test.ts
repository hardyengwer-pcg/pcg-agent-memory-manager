import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverRemoteMcpTools, parseRemoteMcpServers } from '../src/server/remote-mcp.ts';

test('allows the configured HubSpot and Odoo MCP hosts only', () => {
  const servers = parseRemoteMcpServers(JSON.stringify({
    hubspot: { type: 'remote', url: 'https://mcp.hubspot.com', enabled: true },
    odoo: { type: 'remote', url: 'https://odoo-mcp.gateway.pcg.io/mcp/', enabled: true },
  }));
  assert.equal(servers.hubspot.url, 'https://mcp.hubspot.com');
  assert.throws(() => parseRemoteMcpServers(JSON.stringify({ evil: { type: 'remote', url: 'https://evil.example', enabled: true } })), /nicht freigegeben/);
});

test('discovers remote MCP tools without calling tools', async () => {
  const calls: string[] = [];
  const fakeFetch = async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    calls.push(payload.method);
    return new Response(JSON.stringify(payload.method === 'tools/list' ? { result: { tools: [{ name: 'search_projects' }] } } : { result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' },
    });
  };

  const tools = await discoverRemoteMcpTools({ type: 'remote', url: 'https://mcp.hubspot.com', enabled: true }, fakeFetch);

  assert.deepEqual(tools.map(tool => tool.name), ['search_projects']);
  assert.deepEqual(calls, ['initialize', 'tools/list']);
});
