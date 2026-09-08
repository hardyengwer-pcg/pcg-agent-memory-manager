import readline from 'node:readline';
import { searchVerbatimEvidence } from './verbatim-evidence-ledger.ts';
import { queryTemporalTimeline, upsertTemporalFact } from './temporal-facts.ts';
import { searchDecisions, recordDecision } from './decision-memory.ts';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MEMORY_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'memory_search_evidence',
    description: 'Sucht in allen unveränderten Rohquellen (Drive-Dokumente, Transkripte, E-Mails, Chats, Tasks) nach Begriffen mit Zeit-Boost.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriff oder Frage' },
        sourceType: {
          type: 'string',
          enum: ['drive', 'gmail', 'calendar', 'chat', 'tasks'],
          description: 'Optionaler Quellentyp-Filter',
        },
        projectFilter: { type: 'string', description: 'Optionaler Projektfilter' },
        limit: { type: 'number', description: 'Maximale Anzahl Treffer (Standard 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get_timeline',
    description: 'Ruft den temporalen Fakten-Zeitverlauf für ein Subjekt ab (z. B. Mario Pasculli, Sudipt Panda).',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subjekt / Name / Projekt' },
        predicate: { type: 'string', description: 'Optionales Prädikat (z. B. availability, capacity_status)' },
        includeInvalidated: { type: 'boolean', description: 'Auch veraltete/invalidierte Fakten einschließen' },
      },
    },
  },
  {
    name: 'memory_upsert_fact',
    description: 'Speichert einen temporalen Fakt und invalidiert automatisch vorherige widersprüchliche Fakten.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Subjekt (z. B. Mario Pasculli)' },
        predicate: { type: 'string', description: 'Prädikat (z. B. availability)' },
        object: { type: 'string', description: 'Neuer Zustand / Wert' },
        validFrom: { type: 'string', description: 'ISO-Datum für Gültigkeitsbeginn' },
        sourceUrl: { type: 'string', description: 'Link zur Quelle' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
  {
    name: 'memory_search_decisions',
    description: 'Sucht im Entscheidungsgedächtnis nach Beschlüssen, Begründungen und verworfenen Alternativen.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriff in Titel, Begründung oder Alternativen' },
        project: { type: 'string', description: 'Projektfilter (z. B. Koenig & Bauer)' },
        tag: { type: 'string', description: 'Tag-Filter' },
      },
    },
  },
  {
    name: 'memory_record_decision',
    description: 'Speichert eine Architekturentscheidung oder einen Beschluss mit Begründung und Alternativen.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titel der Entscheidung' },
        decision: { type: 'string', description: 'Beschluss / gewählte Lösung' },
        rationale: { type: 'string', description: 'Begründung (warum so entschieden)' },
        alternativesConsidered: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verworfene Alternativen',
        },
        project: { type: 'string', description: 'Projektname' },
        owner: { type: 'string', description: 'Entscheider / Owner' },
        sourceUrl: { type: 'string', description: 'Link zur Quelle' },
      },
      required: ['title', 'decision', 'rationale'],
    },
  },
];

export async function handleMcpToolCall(name: string, args: Record<string, any> = {}): Promise<any> {
  if (name === 'memory_search_evidence') {
    const query = String(args?.query || '');
    const sourceType = args?.sourceType as any;
    const projectFilter = args?.projectFilter as string | undefined;
    const limit = Number(args?.limit) || 5;

    const results = searchVerbatimEvidence({ query, sourceType, projectFilter, limit });
    return { count: results.length, results };
  }

  if (name === 'memory_get_timeline') {
    const subject = args?.subject ? String(args.subject) : undefined;
    const predicate = args?.predicate ? String(args.predicate) : undefined;
    const includeInvalidated = Boolean(args?.includeInvalidated);

    const timeline = queryTemporalTimeline({ subject, predicate, includeInvalidated });
    return { count: timeline.length, timeline };
  }

  if (name === 'memory_upsert_fact') {
    const subject = String(args?.subject || '');
    const predicate = String(args?.predicate || '');
    const object = String(args?.object || '');
    const validFrom = args?.validFrom ? String(args.validFrom) : undefined;
    const sourceUrl = args?.sourceUrl ? String(args.sourceUrl) : undefined;

    return upsertTemporalFact({ subject, predicate, object, validFrom, sourceUrl });
  }

  if (name === 'memory_search_decisions') {
    const query = args?.query ? String(args.query) : undefined;
    const project = args?.project ? String(args.project) : undefined;
    const tag = args?.tag ? String(args.tag) : undefined;

    const decisions = searchDecisions({ query, project, tag });
    return { count: decisions.length, decisions };
  }

  if (name === 'memory_record_decision') {
    const title = String(args?.title || '');
    const decision = String(args?.decision || '');
    const rationale = String(args?.rationale || '');
    const alternativesConsidered = Array.isArray(args?.alternativesConsidered) ? args.alternativesConsidered.map(String) : [];
    const project = args?.project ? String(args.project) : undefined;
    const owner = args?.owner ? String(args.owner) : undefined;
    const sourceUrl = args?.sourceUrl ? String(args.sourceUrl) : undefined;

    return recordDecision({
      title,
      decision,
      rationale,
      alternativesConsidered,
      project,
      owner,
      sourceUrl,
    });
  }

  throw new Error(`Unbekanntes Tool: ${name}`);
}

export function handleJsonRpcMessage(message: any): any {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pcg-memory-manager', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MEMORY_MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    return handleMcpToolCall(params?.name, params?.arguments)
      .then(res => ({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] },
      }))
      .catch(err => ({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err?.message || String(err) },
      }));
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Methode nicht unterstützt: ${method}` },
  };
}

export async function runMemoryMcpStdio() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      const res = await handleJsonRpcMessage(msg);
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } catch (e: any) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })}\n`);
    }
  });
}
