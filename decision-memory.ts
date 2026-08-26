import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DecisionRecordInput {
  title: string;
  project?: string;
  decision: string;
  rationale: string;
  alternativesConsidered: string[];
  owner?: string;
  date?: string;
  sourceUrl?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DecisionRecord extends DecisionRecordInput {
  id: string;
  recordedAt: string;
  contentHash: string;
}

export interface DecisionSearchQuery {
  query?: string;
  project?: string;
  owner?: string;
  tag?: string;
  limit?: number;
}

export function generateDecisionId(title: string, date?: string): string {
  const payload = `${title.trim().toLowerCase()}:${date || ''}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

export function readAllDecisions(ledgerDir = path.join(process.cwd(), '.evidence-ledger')): DecisionRecord[] {
  const filePath = path.join(ledgerDir, 'decisions.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const decisions: DecisionRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      decisions.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // ignore corrupted line safely
    }
  }
  return decisions;
}

export function recordDecision(
  input: DecisionRecordInput,
  ledgerDir = path.join(process.cwd(), '.evidence-ledger'),
): DecisionRecord {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const decisions = readAllDecisions(ledgerDir);
  const recordedAt = new Date().toISOString();
  const date = input.date || recordedAt.split('T')[0];
  const id = generateDecisionId(input.title, date);

  const serialized = JSON.stringify({ ...input, date });
  const contentHash = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');

  const record: DecisionRecord = {
    ...input,
    date,
    id,
    recordedAt,
    contentHash,
    alternativesConsidered: input.alternativesConsidered || [],
  };

  const existingIndex = decisions.findIndex(d => d.id === id);
  if (existingIndex >= 0) {
    decisions[existingIndex] = record;
  } else {
    decisions.push(record);
  }

  const payload = decisions.map(d => `${JSON.stringify(d)}\n`).join('');
  fs.writeFileSync(path.join(ledgerDir, 'decisions.jsonl'), payload, 'utf8');
  return record;
}

export function searchDecisions(
  query: DecisionSearchQuery,
  ledgerDir = path.join(process.cwd(), '.evidence-ledger'),
): DecisionRecord[] {
  const decisions = readAllDecisions(ledgerDir);
  const queryLower = query.query ? query.query.toLowerCase().trim() : '';

  return decisions.filter(d => {
    if (query.project && d.project?.toLowerCase() !== query.project.toLowerCase()) return false;
    if (query.owner && d.owner?.toLowerCase() !== query.owner.toLowerCase()) return false;
    if (query.tag && !d.tags?.some(t => t.toLowerCase() === query.tag?.toLowerCase())) return false;

    if (queryLower) {
      const fullText = `${d.title} ${d.project || ''} ${d.decision} ${d.rationale} ${(d.alternativesConsidered || []).join(' ')} ${d.owner || ''}`.toLowerCase();
      if (!fullText.includes(queryLower)) return false;
    }
    return true;
  }).sort((a, b) => {
    const timeA = new Date(a.date || a.recordedAt).getTime() || 0;
    const timeB = new Date(b.date || b.recordedAt).getTime() || 0;
    return timeB - timeA;
  }).slice(0, query.limit || 50);
}
