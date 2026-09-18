export type RemoteMcpServerConfig = {
  type: 'remote';
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
};

export type RemoteMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const ALLOWED_HOSTS = new Set(['mcp.hubspot.com', 'odoo-mcp.gateway.pcg.io']);
let requestId = 0;

export const DEFAULT_REMOTE_MCP_SERVERS: Record<string, RemoteMcpServerConfig> = {
  hubspot: { type: 'remote', url: 'https://mcp.hubspot.com', enabled: true },
  'odoo-mcp': { type: 'remote', url: 'https://odoo-mcp.gateway.pcg.io/mcp/', enabled: true },
};

export function parseRemoteMcpServers(raw = process.env.REMOTE_MCP_SERVERS_JSON): Record<string, RemoteMcpServerConfig> {
  if (!raw?.trim()) return DEFAULT_REMOTE_MCP_SERVERS;
  const parsed = JSON.parse(raw) as Record<string, RemoteMcpServerConfig>;
  for (const [name, config] of Object.entries(parsed)) {
    if (config.type !== 'remote' || !config.enabled) continue;
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(`Remote-MCP-URL für ${name} ist nicht freigegeben.`);
    }
  }
  return parsed;
}

function parseMcpResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) return response.json();
  return response.text().then(body => {
    const data = body.split(/\r?\n/).filter(line => line.startsWith('data:')).at(-1)?.slice(5).trim();
    return data ? JSON.parse(data) : {};
  });
}

export async function discoverRemoteMcpTools(config: RemoteMcpServerConfig, fetchImpl: typeof fetch = fetch): Promise<RemoteMcpTool[]> {
  if (!config.enabled) return [];
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(config.headers || {}) };
  const initialize = await fetchImpl(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pcg-memory-manager', version: '1.0.0' } } }),
  });
  if (!initialize.ok) throw new Error(`MCP initialize fehlgeschlagen (${initialize.status}).`);
  const initData = await parseMcpResponse(initialize);
  const sessionId = initialize.headers.get('mcp-session-id');
  const toolHeaders = sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers;
  const toolsResponse = await fetchImpl(config.url, {
    method: 'POST',
    headers: toolHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/list', params: {} }),
  });
  if (!toolsResponse.ok) throw new Error(`MCP tools/list fehlgeschlagen (${toolsResponse.status}).`);
  const toolsData = await parseMcpResponse(toolsResponse);
  return (toolsData.result?.tools || initData.result?.tools || []) as RemoteMcpTool[];
}

export async function discoverConfiguredRemoteMcpTools(fetchImpl: typeof fetch = fetch) {
  const servers = parseRemoteMcpServers();
  const results: Record<string, RemoteMcpTool[] | { error: string }> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!config.enabled) continue;
    try {
      results[name] = await discoverRemoteMcpTools(config, fetchImpl);
    } catch (error: any) {
      results[name] = { error: error?.message || String(error) };
    }
  }
  return results;
}
