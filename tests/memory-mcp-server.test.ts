import assert from 'node:assert/strict';
import test from 'node:test';
import { handleJsonRpcMessage, handleMcpToolCall, MEMORY_MCP_TOOLS } from '../memory-mcp-server.ts';

test('lists memory mcp tools correctly', () => {
  assert.equal(MEMORY_MCP_TOOLS.length, 5);
  const toolNames = MEMORY_MCP_TOOLS.map(t => t.name);
  assert.ok(toolNames.includes('memory_search_evidence'));
  assert.ok(toolNames.includes('memory_get_timeline'));
  assert.ok(toolNames.includes('memory_upsert_fact'));
  assert.ok(toolNames.includes('memory_search_decisions'));
  assert.ok(toolNames.includes('memory_record_decision'));
});

test('handles jsonrpc tools/list request', async () => {
  const req = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const res = await handleJsonRpcMessage(req);
  assert.equal(res.id, 1);
  assert.equal(res.result.tools.length, 5);
});

test('handles jsonrpc tools/call for evidence search', async () => {
  const req = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'memory_search_evidence',
      arguments: { query: 'Orderbird', limit: 3 },
    },
  };
  const res = await handleJsonRpcMessage(req);
  assert.equal(res.id, 2);
  assert.ok(res.result.content[0].text);
});
