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

async function refreshStoredRemoteToken(name: string, tokenData: any, fetchImpl: typeof fetch) {
  const tokenEndpoint = name === 'odoo-mcp' ? 'https://auth.gateway.pcg.io/token' : 'https://mcp.atlassian.com/v1/token';
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: tokenData.client_id, refresh_token: tokenData.refresh_token });
  const response = await fetchImpl(tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new Error(`${name}-MCP-Token-Refresh fehlgeschlagen (${response.status}).`);
  const refreshed = await response.json();
  const updated = { ...tokenData, ...refreshed, updatedAt: new Date().toISOString() };
  fs.writeFileSync(name === 'odoo-mcp' ? '.odoo-mcp-token.json' : '.atlassian-mcp-token.json', JSON.stringify(updated, null, 2), 'utf8');
  return refreshed.access_token;
}

async function getStoredRemoteToken(name: string, fetchImpl: typeof fetch) {
  const file = name === 'odoo-mcp' ? '.odoo-mcp-token.json' : '.atlassian-mcp-token.json';
  try {
    const tokenData = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expiresAt = tokenData.expires_at || (tokenData.updatedAt && tokenData.expires_in ? Date.parse(tokenData.updatedAt) + Number(tokenData.expires_in) * 1000 : 0);
    if (tokenData.access_token && expiresAt > Date.now() + 60_000) return tokenData.access_token;
    if (tokenData.refresh_token && tokenData.client_id) return await refreshStoredRemoteToken(name, tokenData, fetchImpl);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return undefined;
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
      const token = await getStoredRemoteToken(name, fetchImpl);
      if (token && !effectiveConfig.headers) effectiveConfig.headers = { Authorization: `Bearer ${token}` };
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

function extractToolJson(result: any): any {
  const text = result?.content?.find((item: any) => item.type === 'text')?.text;
  if (!text) return result?.structuredContent || null;
  try { return JSON.parse(text); } catch { return null; }
}

export async function fetchOdooProjectStatusContext() {
  try {
    const config = await getConfiguredRemoteMcpServerAsync('odoo-mcp');
    const projectQueryFields = ['id', 'name', 'active', 'company_id', 'account_id', 'date_start', 'date', 'allocated_hours', 'effective_hours', 'is_project_overtime', 'last_update_status', 'activity_date_deadline'];
    const taskQueryFields = ['id', 'name', 'active', 'project_id', 'stage_id', 'date_deadline', 'planned_hours', 'effective_hours'];
    const [projectsResult, tasksResult] = await Promise.all([
      callRemoteMcpTool(config, 'search_records', { request: {
        model: 'project.project',
        domain: [],
        fields: projectQueryFields,
        limit: 100,
      } }),
      callRemoteMcpTool(config, 'search_records', { request: {
        model: 'project.task',
        domain: [],
        fields: taskQueryFields,
        limit: 100,
      } }),
    ]);
    const projects = extractToolRecords(projectsResult).filter(project => project.active !== false).slice(0, 40).map(project => ({
      ...project,
      customer: project.partner_id || project.company_id || project.account_id || null,
      time_left_hours: typeof project.allocated_hours === 'number' && typeof project.effective_hours === 'number'
        ? project.allocated_hours - project.effective_hours
        : null,
    }));
    const tasks = extractToolRecords(tasksResult).filter(task => task.active !== false).slice(0, 80);
    const relationName = (value: any) => Array.isArray(value) ? value[1] : value || 'unbekannt';
    const projectLines = projects.map(project => `- Odoo-Projekt-ID ${project.id} | Projekt: ${project.name} | Kunde/Account: ${relationName(project.customer)} | Beauftragt: ${project.allocated_hours ?? 'n/a'}h | Verbraucht: ${project.effective_hours ?? 'n/a'}h | Time left: ${project.time_left_hours ?? 'n/a'}h | Overrun: ${project.is_project_overtime ? 'JA' : 'nein'} | Status: ${project.last_update_status || 'n/a'}`).join('\n');
    const taskLines = tasks.map(task => `- Odoo-Task-ID ${task.id} | Task: ${task.name} | Projekt: ${relationName(task.project_id)} | Status: ${relationName(task.stage_id)} | Fällig: ${task.date_deadline || 'n/a'} | Geplant: ${task.planned_hours ?? 'n/a'}h | Verbraucht: ${task.effective_hours ?? 'n/a'}h`).join('\n');
    return `Odoo-Projekt- und Zeiterfassungskontext (read-only, aktuelle Daten):\n[Quelle: Odoo MCP – project.project / project.task](https://odoo-mcp.gateway.pcg.io/mcp/)\nPROJEKTE / KUNDEN / RESTSTUNDEN:\n${projectLines || '(Keine aktiven Odoo-Projekte geliefert.)'}\nAKTIVE TASKS / ZEITERFASSUNG:\n${taskLines || '(Keine aktiven Odoo-Tasks geliefert.)'}\n`;
  } catch (error: any) {
    console.warn('Odoo MCP project context notice:', error?.message || error);
    return '(Odoo-MCP-Projektkontext nicht verfügbar; keine Odoo-Fakten ableiten.)\n';
  }
}

export async function fetchAtlassianJiraStatusContext() {
  try {
    const config = await getConfiguredRemoteMcpServerAsync('atlassian');
    const resourcesResult = await callRemoteMcpTool(config, 'getAccessibleAtlassianResources');
    const resources = extractToolJson(resourcesResult);
    const jiraResource = Array.isArray(resources) ? resources.find(resource => resource.scopes?.includes('read:jira-work')) : null;
    if (!jiraResource?.id) return '(Jira-MCP liefert keine zugängliche Jira-Ressource.)\n';
    const issuesResult = await callRemoteMcpTool(config, 'searchJiraIssuesUsingJql', {
      cloudId: jiraResource.id,
      jql: 'updated >= -14d ORDER BY updated DESC',
      maxResults: 50,
      fields: ['summary', 'status', 'project', 'priority', 'assignee', 'updated', 'labels'],
    });
    const jiraData = extractToolJson(issuesResult) || {};
    const issues = Array.isArray(jiraData.issues) ? jiraData.issues.slice(0, 40).map((issue: any) => ({
      key: issue.key,
      summary: issue.fields?.summary,
      project: issue.fields?.project,
      status: issue.fields?.status,
      priority: issue.fields?.priority,
      assignee: issue.fields?.assignee,
      updated: issue.fields?.updated,
      labels: issue.fields?.labels,
    })) : jiraData;
    const issueLines = Array.isArray(issues) ? issues.map((issue: any) => `- Jira ${issue.key || 'n/a'} | Projekt: ${issue.project?.name || issue.project?.key || 'n/a'} | ${issue.summary || 'ohne Summary'} | Status: ${issue.status?.name || 'n/a'} | Priorität: ${issue.priority?.name || 'n/a'} | Assignee: ${issue.assignee?.displayName || issue.assignee?.emailAddress || 'unassigned'} | Updated: ${issue.updated || 'n/a'} | Labels: ${(issue.labels || []).join(', ') || 'keine'}`).join('\n') : JSON.stringify(issues);
    return `Jira-Projektstatus (read-only, letzte 14 Tage, Site: ${jiraResource.url}):\n[Quelle: Atlassian MCP – Jira searchJiraIssuesUsingJql](https://mcp.atlassian.com/v1/mcp/authv2)\nISSUES:\n${issueLines || '(Keine aktuellen Jira-Issues geliefert.)'}\n`;
  } catch (error: any) {
    console.warn('Atlassian Jira context notice:', error?.message || error);
    return '(Jira-MCP-Projektkontext nicht verfügbar; keine Jira-Fakten ableiten.)\n';
  }
}

export function getConfiguredRemoteMcpServer(name: string): RemoteMcpServerConfig {
  const config = parseRemoteMcpServers()[name];
  if (!config) throw new Error(`Kein Remote-MCP-Server '${name}' konfiguriert.`);
  return { ...config };
}

export async function getConfiguredRemoteMcpServerAsync(name: string, fetchImpl: typeof fetch = fetch): Promise<RemoteMcpServerConfig> {
  const config = getConfiguredRemoteMcpServer(name);
  const token = await getStoredRemoteToken(name, fetchImpl);
  return token && !config.headers ? { ...config, headers: { Authorization: `Bearer ${token}` } } : config;
}
import fs from 'node:fs';
