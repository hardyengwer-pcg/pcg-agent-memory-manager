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
    const namedProjectAliases = [
      { alias: 'HHA', terms: ['HHA', 'Hamburger Hochbahn'] },
      { alias: 'VOEST', terms: ['VOEST', 'voestalpine'] },
      { alias: 'Suse', terms: ['Suse', 'SUSE'] },
    ];
    const [projectsResult, tasksResult, ...aliasAccountResults] = await Promise.all([
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
      ...namedProjectAliases.flatMap(({ terms }) => terms.map(term => callRemoteMcpTool(config, 'search_records', { request: {
        model: 'account.analytic.account',
        domain: [{ field: 'name', operator: 'ilike', value: term }],
        fields: ['id', 'name', 'partner_id'],
        limit: 100,
      } }))),
    ]);
    const aliasProjects = await Promise.all(namedProjectAliases.map(async ({ alias, terms }, aliasIndex) => {
      const namePattern = alias === 'HHA' ? /hamburger\s+hochbahn|\bhha\b/i : alias === 'VOEST' ? /voestalpine|\bvoest\b/i : /\bsuse\b/i;
      const accountRecords = terms.flatMap((_, termIndex) => extractToolRecords(aliasAccountResults[aliasIndex * terms.length + termIndex]))
        .filter(account => namePattern.test(`${account.name || ''} ${Array.isArray(account.partner_id) ? account.partner_id[1] : account.partner_id || ''}`));
      const accountIds = [...new Set(accountRecords.map(account => account.id).filter(Boolean))];
      const aliasSearchResults = await Promise.all([
        ...terms.map(term => callRemoteMcpTool(config, 'search_records', { request: {
          model: 'project.project',
          domain: [{ field: 'name', operator: 'ilike', value: term }],
          fields: projectQueryFields,
          limit: 100,
        } })),
        accountIds.length > 0 ? callRemoteMcpTool(config, 'search_records', { request: {
          model: 'project.project',
          domain: [{ field: 'account_id', operator: 'in', value: accountIds }],
          fields: projectQueryFields,
          limit: 100,
        } }) : Promise.resolve(null),
      ]);
      const nameMatches = aliasSearchResults.slice(0, terms.length);
      const accountMatches = aliasSearchResults[terms.length];
      const records = [...nameMatches.flatMap(extractToolRecords).filter(project => namePattern.test(project.name || '')), ...extractToolRecords(accountMatches)]
        .filter(project => project.active !== false)
        .filter((project, index, all) => all.findIndex(other => other.id === project.id) === index);
      return { alias, records };
    }));
    const [dataTagResult, aiTagResult] = await Promise.all(['Data', 'AI'].map(tag => callRemoteMcpTool(config, 'search_records', { request: {
      model: 'documents.tag',
      domain: [{ field: 'name', operator: 'ilike', value: tag }],
      fields: ['id', 'name'],
      limit: 100,
    } })));
    const dataAiTagIds = [...new Set([...extractToolRecords(dataTagResult), ...extractToolRecords(aiTagResult)].map(tag => tag.id).filter(Boolean))];
    const taggedProjectsResult = dataAiTagIds.length > 0 ? await callRemoteMcpTool(config, 'search_records', { request: {
      model: 'project.project',
      domain: [{ field: 'documents_tag_ids', operator: 'in', value: dataAiTagIds }],
      fields: ['id', 'name', 'documents_tag_ids'],
      limit: 100,
    } }) : null;
    const taggedProjects = extractToolRecords(taggedProjectsResult);
    const taggedProjectIds = taggedProjects.map(project => project.id).filter(Boolean);
    const taggedTasksResult = taggedProjectIds.length > 0 ? await callRemoteMcpTool(config, 'search_records', { request: {
      model: 'project.task',
      domain: [{ field: 'project_id', operator: 'in', value: taggedProjectIds }],
      fields: ['id', 'name', 'active', 'project_id', 'activity_user_id', 'stage_id', 'date_deadline', 'planned_hours', 'effective_hours'],
      limit: 100,
    } }) : null;
    const relationName = (value: any) => Array.isArray(value) ? value[1] : value || 'unbekannt';
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartISO = monthStart.toISOString().slice(0, 10);
    const todayISO = new Date().toISOString().slice(0, 10);
    const squadNames = ['Hardy Engwer', 'Anne Lendl', 'Arpit Gothwal', 'Baran Ege', 'Barbara Faulstich', 'Enrico Goerlitz', 'Julius Otto', 'Klemens Wisser', 'Mario Pasculli', 'Nils Traut', 'Paul Grillenberger', 'Sudipt Panda', 'Juan José Valenzuela Morales', 'Michael Zeiner', 'Peter Eichinger', 'Timo Dempwolf', 'Christian Zierer'];
    const squadUserResults = await Promise.all(squadNames.map(name => callRemoteMcpTool(config, 'search_records', { request: {
      model: 'res.users',
      domain: [{ field: 'name', operator: 'ilike', value: name }],
      fields: ['id', 'name'],
      limit: 5,
    } })));
    const squadUsers = squadUserResults.flatMap(extractToolRecords).filter((user, index, all) => all.findIndex(other => other.id === user.id) === index);
    const squadBookingResults = await Promise.all(squadUsers.map(user => callRemoteMcpTool(config, 'search_records', { request: {
      model: 'account.analytic.line',
      domain: [
        { field: 'date', operator: '>=', value: monthStartISO },
        { field: 'date', operator: '<=', value: todayISO },
        { field: 'user_id', operator: '=', value: user.id },
      ],
      fields: ['id', 'date', 'project_id', 'user_id', 'unit_amount'],
      limit: 100,
    } })));
    const squadBookings = squadBookingResults.flatMap(extractToolRecords).filter(line => Array.isArray(line.project_id) && Number(line.unit_amount) > 0 && !/pcg global|pcg int\.? projects|^intern(?:al)?$|jira sync|^support$/i.test(line.project_id[1] || ''));
    const bookedProjectIds = [...new Set(squadBookings.map(line => line.project_id[0]).filter(Boolean))];
    const bookedProjectsResult = bookedProjectIds.length > 0 ? await callRemoteMcpTool(config, 'search_records', { request: {
      model: 'project.project',
      domain: [{ field: 'id', operator: 'in', value: bookedProjectIds }],
      fields: ['id', 'name', 'allocated_hours', 'effective_hours'],
      limit: 100,
    } }) : null;
    const bookedProjects = new Map(extractToolRecords(bookedProjectsResult).map(project => [project.id, project]));
    const hardyPmProjectsResult = await callRemoteMcpTool(config, 'search_records', { request: {
      model: 'project.project',
      domain: [{ field: 'additional_manager_ids', operator: 'in', value: [13566] }],
      fields: ['id', 'name', 'allocated_hours', 'effective_hours'],
      limit: 100,
    } });
    const hardyPmProjectIds = new Set(extractToolRecords(hardyPmProjectsResult).map(project => project.id));
    const elapsedDays = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / 86400000));
    const squadBookingGroups = new Map<string, { user: string; project: any; hours: number }>();
    for (const line of squadBookings) {
      const userName = relationName(line.user_id);
      const project = bookedProjects.get(line.project_id[0]) || { id: line.project_id[0], name: line.project_id[1] };
      const key = `${userName}|${project.id}`;
      const current = squadBookingGroups.get(key) || { user: userName, project, hours: 0 };
      current.hours += Number(line.unit_amount) || 0;
      squadBookingGroups.set(key, current);
    }
    const squadBookingLines = [...squadBookingGroups.values()].map(({ user, project, hours }) => {
      const remaining = typeof project.allocated_hours === 'number' && typeof project.effective_hours === 'number'
        ? project.allocated_hours - project.effective_hours : null;
      const dailyRate = hours / elapsedDays;
      const forecast = remaining !== null && remaining > 0 && hours >= 8 && dailyRate > 0
        ? new Date(Date.now() + Math.ceil(remaining / dailyRate) * 86400000).toISOString().slice(0, 10)
        : remaining !== null && remaining <= 0 ? 'bereits verbraucht/überschritten' : 'keine belastbare Prognose (<8h Monatsbasis)';
      const hardyPmMarker = hardyPmProjectIds.has(project.id) ? ' | Hardy-PM-Projekt' : '';
      return `- Squad-Mitglied: ${user} | Odoo-Projekt: ${project.name} | Gebucht im laufenden Monat: ${hours.toFixed(2)}h | Reststunden gesamt: ${remaining === null ? 'n/a' : `${remaining.toFixed(2)}h`} | Prognose bei aktuellem Tempo: ${forecast}${hardyPmMarker}`;
    }).join('\n');
    const hardyPmGroups = new Map<number, { project: any; hours: number }>();
    for (const line of squadBookings) {
      const projectId = line.project_id[0];
      if (!hardyPmProjectIds.has(projectId)) continue;
      const project = bookedProjects.get(projectId);
      if (!project) continue;
      const current = hardyPmGroups.get(projectId) || { project, hours: 0 };
      current.hours += Number(line.unit_amount) || 0;
      hardyPmGroups.set(projectId, current);
    }
    const hardyPmLines = [...hardyPmGroups.values()].map(({ project, hours }) => {
      const remaining = typeof project.allocated_hours === 'number' && typeof project.effective_hours === 'number'
        ? project.allocated_hours - project.effective_hours : null;
      const dailyRate = hours / elapsedDays;
      const forecast = remaining !== null && remaining > 0 && hours >= 8 && dailyRate > 0
        ? new Date(Date.now() + Math.ceil(remaining / dailyRate) * 86400000).toISOString().slice(0, 10)
        : remaining !== null && remaining <= 0 ? 'bereits verbraucht/überschritten' : 'keine belastbare Prognose (<8h Monatsbasis)';
      return `- Hardy-PM-Projekt: ${project.name} | Squad-Buchungen laufender Monat: ${hours.toFixed(2)}h | Reststunden: ${remaining === null ? 'n/a' : `${remaining.toFixed(2)}h`} | Prognose: ${forecast}`;
    }).join('\n');
    const capacityGroups = new Map<string, { hours: number; projects: Set<number>; forecasts: string[] }>();
    for (const line of squadBookingGroups.values()) {
      const current = capacityGroups.get(line.user) || { hours: 0, projects: new Set<number>(), forecasts: [] };
      current.hours += line.hours;
      current.projects.add(line.project.id);
      const remaining = typeof line.project.allocated_hours === 'number' && typeof line.project.effective_hours === 'number'
        ? line.project.allocated_hours - line.project.effective_hours : null;
      if (remaining !== null && remaining > 0 && line.hours >= 8) current.forecasts.push(new Date(Date.now() + Math.ceil(remaining / (line.hours / elapsedDays)) * 86400000).toISOString().slice(0, 10));
      capacityGroups.set(line.user, current);
    }
    const capacityLines = [...capacityGroups.entries()].map(([user, value]) => {
      const forecasts = value.forecasts.sort();
      const nextForecast = forecasts[0] || 'keine belastbare Prognose';
      const daysToForecast = forecasts[0] ? Math.ceil((Date.parse(forecasts[0]) - Date.now()) / 86400000) : null;
      const warning = daysToForecast !== null && daysToForecast <= 14 ? ' | WARNUNG: bald ohne Reststunden' : '';
      return `- ${user}: ${value.projects.size} aktuelle Projekte | Monatsbuchungen: ${value.hours.toFixed(2)}h | früheste Reststunden-Prognose: ${nextForecast}${warning}`;
    }).join('\n');
    const aliasTaskResults = await Promise.all(namedProjectAliases.map(({ terms }) => Promise.all(
      terms.map(term => callRemoteMcpTool(config, 'search_records', { request: {
        model: 'project.task',
        domain: [{ field: 'name', operator: 'ilike', value: term }],
        fields: ['id', 'name', 'active', 'project_id', 'activity_user_id', 'stage_id'],
        limit: 100,
      } }))
    )));
    const projects = extractToolRecords(projectsResult).filter(project => project.active !== false).slice(0, 40).map(project => ({
      ...project,
      customer: project.partner_id || project.company_id || project.account_id || null,
      time_left_hours: typeof project.allocated_hours === 'number' && typeof project.effective_hours === 'number'
        ? project.allocated_hours - project.effective_hours
        : null,
    }));
    const tasks = extractToolRecords(tasksResult).filter(task => task.active !== false).slice(0, 80);
    const projectLines = projects.map(project => `- Odoo-Projekt-ID ${project.id} | Projekt: ${project.name} | Kunde/Account: ${relationName(project.customer)} | Beauftragt: ${project.allocated_hours ?? 'n/a'}h | Verbraucht: ${project.effective_hours ?? 'n/a'}h | Time left: ${project.time_left_hours ?? 'n/a'}h | Overrun: ${project.is_project_overtime ? 'JA' : 'nein'} | Status: ${project.last_update_status || 'n/a'}`).join('\n');
    const taskLines = tasks.map(task => `- Odoo-Task-ID ${task.id} | Task: ${task.name} | Projekt: ${relationName(task.project_id)} | Status: ${relationName(task.stage_id)} | Fällig: ${task.date_deadline || 'n/a'} | Geplant: ${task.planned_hours ?? 'n/a'}h | Verbraucht: ${task.effective_hours ?? 'n/a'}h`).join('\n');
    const dataAiTaskLines = extractToolRecords(taggedTasksResult)
      .filter(task => task.active !== false)
      .map(task => `- Odoo-Task-ID ${task.id} | Task: ${task.name} | Eindeutiges Odoo-Projekt: ${relationName(task.project_id)} | Verantwortlich: ${relationName(task.activity_user_id)} | Status: ${relationName(task.stage_id)}`)
      .join('\n');
    const aliasLines = aliasProjects.map(({ alias, records }, aliasIndex) => {
      const taskPattern = alias === 'HHA' ? /hamburger\s+hochbahn|\bhha\b/i : alias === 'VOEST' ? /voestalpine|\bvoest\b/i : /\bsuse\b/i;
      const taskProjects = aliasTaskResults[aliasIndex].flatMap(extractToolRecords)
        .filter(task => task.active !== false && taskPattern.test(task.name || '') && Array.isArray(task.project_id))
        .map(task => ({ id: task.project_id[0], name: task.project_id[1] }));
      const allRecords = [...records, ...taskProjects].filter((project, index, all) => all.findIndex(other => other.id === project.id) === index);
      return `- ${alias}: ${allRecords.length > 0 ? allRecords.map(project => `Odoo-Projekt-ID ${project.id} | exakter Odoo-Name: ${project.name}`).join(' || ') : '(kein eindeutiger Odoo-Treffer)'}`;
    }).join('\n');
    const taggedProjectLines = taggedProjects.map(project => `- Odoo-Projekt-ID ${project.id} | exakter Odoo-Name: ${project.name}`).join('\n');
    return `Odoo-Projekt- und Zeiterfassungskontext (read-only, aktuelle Daten):\n[Quelle: Odoo MCP – project.project / project.task / account.analytic.line](https://odoo-mcp.gateway.pcg.io/mcp/)\nVERBINDLICHE NAMENSZUORDNUNG FÜR DEN BERICHT (immer den exakten Odoo-Namen verwenden):\n${aliasLines}\nHARDY-PM-PROJEKTE IM LAUFENDEN MONAT (Odoo additional_manager_ids, Hardy-ID 13566):\n${hardyPmLines || '(Keine Hardy-PM-Projekte mit aktueller Squad-Buchung gefunden.)'}\nKAPAZITÄTSAUSBLICK SQUAD (aktuelle Monatsbuchungen):\n${capacityLines || '(Keine aktuellen Squad-Buchungen gefunden.)'}\nPROJEKTE DER SQUAD IM LAUFENDEN MONAT (Zuordnung über tatsächliche Odoo-Zeitbuchungen; Hardy ist ausdrücklich enthalten):\n${squadBookingLines || '(Keine aktuellen Odoo-Zeitbuchungen der konfigurierten Squad-Mitglieder gefunden.)'}\nDie Prognose ist eine Näherung aus dem bisherigen Monatsverbrauch, keine verbindliche Lieferzusage.\nDATA/AI-PROJEKTPOOL UND SQUAD-TASK-ZUORDNUNG (project_id ist die führende Zuordnung):\n${taggedProjectLines || '(Keine Data/AI-getaggten Odoo-Projekte geliefert.)'}\n${dataAiTaskLines || '(Keine aktiven Tasks zu Data/AI-Projekten geliefert.)'}\nPROJEKTE / KUNDEN / RESTSTUNDEN:\n${projectLines || '(Keine aktiven Odoo-Projekte geliefert.)'}\nAKTIVE TASKS / ZEITERFASSUNG:\n${taskLines || '(Keine aktiven Odoo-Tasks geliefert.)'}\n`;
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
