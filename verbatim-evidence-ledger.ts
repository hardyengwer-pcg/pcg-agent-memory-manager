import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type EvidenceSourceType = 'drive' | 'gmail' | 'calendar' | 'chat' | 'tasks';

export interface VerbatimEvidenceInput {
  sourceType: EvidenceSourceType;
  sourceId: string;
  content: string;
  sourceTimestamp?: string;
  author?: string;
  sourceUrl?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface VerbatimEvidenceRecord extends VerbatimEvidenceInput {
  observedAt: string;
  contentHash: string;
  version: number;
}

export interface EvidenceSearchQuery {
  query: string;
  sourceType?: EvidenceSourceType;
  limit?: number;
  minScore?: number;
  projectFilter?: string;
}

export interface EvidenceSearchResult {
  record: VerbatimEvidenceRecord;
  score: number;
  matchedTerms: string[];
  snippet: string;
}

export function hashEvidenceContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function readAllEvidence(ledgerDir = path.join(process.cwd(), '.evidence-ledger')): VerbatimEvidenceRecord[] {
  const ledgerPath = path.join(ledgerDir, 'evidence.jsonl');
  if (!fs.existsSync(ledgerPath)) return [];
  const records: VerbatimEvidenceRecord[] = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as VerbatimEvidenceRecord);
    } catch {
      // ignore corrupted line safely
    }
  }
  return records;
}

export function appendVerbatimEvidence(
  inputs: VerbatimEvidenceInput[],
  ledgerDir = path.join(process.cwd(), '.evidence-ledger'),
): VerbatimEvidenceRecord[] {
  const validInputs = inputs.filter(input => input.sourceId && typeof input.content === 'string');
  if (validInputs.length === 0) return [];

  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = path.join(ledgerDir, 'evidence.jsonl');
  const existingKeys = new Set<string>();
  const latestVersions = new Map<string, number>();

  if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as VerbatimEvidenceRecord;
        existingKeys.add(`${record.sourceType}:${record.sourceId}:${record.contentHash}`);
        const versionKey = `${record.sourceType}:${record.sourceId}`;
        latestVersions.set(versionKey, Math.max(latestVersions.get(versionKey) || 0, record.version || 0));
      } catch {
        // Keep a corrupt historical line immutable; future writes remain append-only.
      }
    }
  }

  const records: VerbatimEvidenceRecord[] = [];
  for (const input of validInputs) {
    const contentHash = hashEvidenceContent(input.content);
    const key = `${input.sourceType}:${input.sourceId}:${contentHash}`;
    if (existingKeys.has(key)) continue;

    const versionKey = `${input.sourceType}:${input.sourceId}`;
    const record: VerbatimEvidenceRecord = {
      ...input,
      observedAt: new Date().toISOString(),
      contentHash,
      version: (latestVersions.get(versionKey) || 0) + 1,
    };
    records.push(record);
    existingKeys.add(key);
    latestVersions.set(versionKey, record.version);
  }

  if (records.length > 0) {
    fs.appendFileSync(ledgerPath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8');
  }
  return records;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_\-\/]/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1);
}

function calculateRecencyBoost(isoDate?: string): number {
  if (!isoDate) return 0;
  const timestamp = new Date(isoDate).getTime();
  if (Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (ageDays <= 2) return 1.5;
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 14) return 0.5;
  if (ageDays <= 30) return 0.2;
  return 0;
}

function makeSnippet(content: string, terms: string[]): string {
  if (!content) return '';
  const lower = content.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(content.length, idx + term.length + 120);
      return `${start > 0 ? '...' : ''}${content.slice(start, end).trim()}${end < content.length ? '...' : ''}`;
    }
  }
  return content.slice(0, 200).trim();
}

export function searchVerbatimEvidence(
  query: EvidenceSearchQuery,
  ledgerDir = path.join(process.cwd(), '.evidence-ledger'),
): EvidenceSearchResult[] {
  const records = readAllEvidence(ledgerDir);
  const queryTokens = tokenize(query.query);
  if (queryTokens.length === 0) return [];

  const results: EvidenceSearchResult[] = [];
  const minScore = query.minScore ?? 0.5;
  const limit = query.limit ?? 10;

  for (const record of records) {
    if (query.sourceType && record.sourceType !== query.sourceType) continue;

    const metadataStr = record.metadata ? JSON.stringify(record.metadata) : '';
    const searchableText = `${record.content}\n${metadataStr}\n${record.author || ''}\n${record.sourceUrl || ''}`;
    const searchableTokens = new Set(tokenize(searchableText));
    const searchableLower = searchableText.toLowerCase();

    let score = 0;
    const matchedTerms: string[] = [];

    // Exact full query match
    if (searchableLower.includes(query.query.toLowerCase().trim())) {
      score += 5.0;
      matchedTerms.push(query.query.toLowerCase().trim());
    }

    // Token matches
    for (const token of queryTokens) {
      if (searchableTokens.has(token) || searchableLower.includes(token)) {
        score += 1.0;
        matchedTerms.push(token);
      }
    }

    if (query.projectFilter) {
      const projLower = query.projectFilter.toLowerCase();
      if (searchableLower.includes(projLower)) {
        score += 2.0;
      }
    }

    // Temporal recency boost
    score += calculateRecencyBoost(record.sourceTimestamp || record.observedAt);

    if (score >= minScore && matchedTerms.length > 0) {
      results.push({
        record,
        score: Number(score.toFixed(2)),
        matchedTerms: [...new Set(matchedTerms)],
        snippet: makeSnippet(record.content, matchedTerms),
      });
    }
  }

  // Sort by score descending, then by newest timestamp descending
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const timeA = new Date(a.record.sourceTimestamp || a.record.observedAt).getTime() || 0;
    const timeB = new Date(b.record.sourceTimestamp || b.record.observedAt).getTime() || 0;
    return timeB - timeA;
  });

  return results.slice(0, limit);
}
