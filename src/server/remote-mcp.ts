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

const ALLOWED_HOSTS = new Set(['odoo-mcp.gateway.pcg.io', 'mcp.atlassian.com']);
let requestId = 0;

export const DEFAULT_REMOTE_MCP_SERVERS: Record<string, RemoteMcpServerConfig> = {
  'odoo-mcp': { type: 'remote', url: 'https://odoo-mcp.gateway.pcg.io/mcp/', enabled: true },
  atlassian: { type: 'remote', url: 'https://mcp.atlassian.com/v1/mcp/authv2', enabled: true },
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

async function initializeRemoteMcp(config: RemoteMcpServerConfig, fetchImpl: typeof fetch) {
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(config.headers || {}) };
  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pcg-memory-manager', version: '1.0.0' } } }),
  });
  if (!response.ok) throw new Error(`MCP initialize fehlgeschlagen (${response.status}).`);
  await parseMcpResponse(response);
  return { headers: response.headers.get('mcp-session-id') ? { ...headers, 'Mcp-Session-Id': response.headers.get('mcp-session-id')! } : headers };
}

export async function discoverRemoteMcpTools(config: RemoteMcpServerConfig, fetchImpl: typeof fetch = fetch): Promise<RemoteMcpTool[]> {
  if (!config.enabled) return [];
  const { headers: toolHeaders } = await initializeRemoteMcp(config, fetchImpl);
  const toolsResponse = await fetchImpl(config.url, {
    method: 'POST',
    headers: toolHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/list', params: {} }),
  });
  if (!toolsResponse.ok) throw new Error(`MCP tools/list fehlgeschlagen (${toolsResponse.status}).`);
  const toolsData = await parseMcpResponse(toolsResponse);
  return (toolsData.result?.tools || []) as RemoteMcpTool[];
}

export async function callRemoteMcpTool(config: RemoteMcpServerConfig, name: string, args: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch) {
  if (!config.enabled) throw new Error('Remote-MCP-Server ist deaktiviert.');
  const { headers } = await initializeRemoteMcp(config, fetchImpl);
  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!response.ok) throw new Error(`MCP tools/call fehlgeschlagen (${response.status}).`);
  const data = await parseMcpResponse(response);
  if (data.error) throw new Error(data.error.message || 'Remote-MCP-Tool fehlgeschlagen.');
  return data.result;
}

export async function discoverConfiguredRemoteMcpTools(fetchImpl: typeof fetch = fetch) {
  const servers = parseRemoteMcpServers();
  const results: Record<string, RemoteMcpTool[] | { error: string }> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (!config.enabled) continue;
    try {
      const effectiveConfig = { ...config };
      if (name === 'odoo-mcp' && !effectiveConfig.headers) {
        try {
          const token = JSON.parse(fs.readFileSync('.odoo-mcp-token.json', 'utf8')).access_token;
          if (token) effectiveConfig.headers = { Authorization: `Bearer ${token}` };
        } catch {
          // Discovery will report the remote 401 until the one-time auth flow is completed.
        }
      }
      results[name] = await discoverRemoteMcpTools(effectiveConfig, fetchImpl);
    } catch (error: any) {
      results[name] = { error: error?.message || String(error) };
    }
  }
  return results;
}

function extractToolRecords(result: any): any[] {
  if (Array.isArray(result?.structuredContent?.records)) return result.structuredContent.records;
  const text = result?.content?.find((item: any) => item.type === 'text')?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

export async function fetchOdooProjectStatusContext() {
  try {
    const config = getConfiguredRemoteMcpServer('odoo-mcp');
    const projectFieldResult = await callRemoteMcpTool(config, 'get_model_fields', { model: 'project.project' });
    const taskFieldResult = await callRemoteMcpTool(config, 'get_model_fields', { model: 'project.task' });
    const availableFields = (result: any) => new Set(extractToolRecords(result).map(field => field.name));
    const projectFields = availableFields(projectFieldResult);
    const taskFields = availableFields(taskFieldResult);
    const selectFields = (available: Set<string>, candidates: string[]) => candidates.filter(field => available.has(field));
    const projectQueryFields = selectFields(projectFields, ['id', 'name', 'partner_id', 'company_id', 'account_id', 'date_start', 'date', 'allocated_hours', 'effective_hours', 'is_project_overtime', 'last_update_status', 'activity_date_deadline']);
    const taskQueryFields = selectFields(taskFields, ['id', 'name', 'project_id', 'stage_id', 'date_deadline', 'planned_hours', 'effective_hours']);
    const [projectsResult, tasksResult] = await Promise.all([
      callRemoteMcpTool(config, 'search_records', {
        model: 'project.project',
        domain: [{ field: 'active', operator: '=', value: true }],
        fields: projectQueryFields,
        limit: 100,
      }),
      callRemoteMcpTool(config, 'search_records', {
        model: 'project.task',
        domain: [{ field: 'active', operator: '=', value: true }],
        fields: taskQueryFields,
        limit: 100,
      }),
    ]);
    const projects = extractToolRecords(projectsResult).map(project => ({
      ...project,
      customer: project.partner_id || project.company_id || project.account_id || null,
      time_left_hours: typeof project.allocated_hours === 'number' && typeof project.effective_hours === 'number'
        ? Math.max(0, project.allocated_hours - project.effective_hours)
        : null,
    }));
    const tasks = extractToolRecords(tasksResult);
    return `Odoo-Projekt- und Zeiterfassungskontext (read-only, aktuelle Daten):\nProjekte:\n${JSON.stringify(projects, null, 2)}\nOffene/aktive Tasks:\n${JSON.stringify(tasks, null, 2)}\n`;
  } catch (error: any) {
    console.warn('Odoo MCP project context notice:', error?.message || error);
    return '(Odoo-MCP-Projektkontext nicht verfügbar; keine Odoo-Fakten ableiten.)\n';
  }
}

export function getConfiguredRemoteMcpServer(name: string): RemoteMcpServerConfig {
  const config = parseRemoteMcpServers()[name];
  if (!config) throw new Error(`Kein Remote-MCP-Server '${name}' konfiguriert.`);
  const effectiveConfig = { ...config };
  if (name === 'odoo-mcp' && !effectiveConfig.headers) {
    try {
      const token = JSON.parse(fs.readFileSync('.odoo-mcp-token.json', 'utf8')).access_token;
      if (token) effectiveConfig.headers = { Authorization: `Bearer ${token}` };
    } catch {
      // The remote server will return 401 until authentication is completed.
    }
  }
  return effectiveConfig;
}
import fs from 'node:fs';
