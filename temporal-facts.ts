import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TemporalFactInput {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  validTo?: string;
  sourceUrl?: string;
  sourceType?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface TemporalFactRecord extends TemporalFactInput {
  id: string;
  createdAt: string;
  status: 'active' | 'invalidated';
  invalidatedAt?: string;
  invalidatedByFactId?: string;
}

export interface FactTimelineQuery {
  subject?: string;
  predicate?: string;
  includeInvalidated?: boolean;
}

function normalizeKey(str: string): string {
  return str.trim().toLowerCase();
}

export function generateFactId(subject: string, predicate: string, object: string, validFrom?: string): string {
  const payload = `${normalizeKey(subject)}:${normalizeKey(predicate)}:${normalizeKey(object)}:${validFrom || ''}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

export function readAllTemporalFacts(factsDir = path.join(process.cwd(), '.evidence-ledger')): TemporalFactRecord[] {
  const filePath = path.join(factsDir, 'temporal-facts.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const facts: TemporalFactRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      facts.push(JSON.parse(line) as TemporalFactRecord);
    } catch {
      // safe skip
    }
  }
  return facts;
}

function writeAllTemporalFacts(facts: TemporalFactRecord[], factsDir = path.join(process.cwd(), '.evidence-ledger')): void {
  fs.mkdirSync(factsDir, { recursive: true });
  const filePath = path.join(factsDir, 'temporal-facts.jsonl');
  const payload = facts.map(f => `${JSON.stringify(f)}\n`).join('');
  fs.writeFileSync(filePath, payload, 'utf8');
}

export function upsertTemporalFact(
  input: TemporalFactInput,
  factsDir = path.join(process.cwd(), '.evidence-ledger'),
): { fact: TemporalFactRecord; invalidatedCount: number } {
  const existingFacts = readAllTemporalFacts(factsDir);
  const nowISO = new Date().toISOString();
  const validFrom = input.validFrom || nowISO;
  const newId = generateFactId(input.subject, input.predicate, input.object, validFrom);

  let invalidatedCount = 0;
  // If a contradicting fact exists for the exact same subject & predicate with open validTo, invalidate it
  const updatedFacts = existingFacts.map(fact => {
    const sameSubject = normalizeKey(fact.subject) === normalizeKey(input.subject);
    const samePredicate = normalizeKey(fact.predicate) === normalizeKey(input.predicate);
    const differentObject = normalizeKey(fact.object) !== normalizeKey(input.object);

    if (sameSubject && samePredicate && differentObject && fact.status === 'active' && !fact.validTo) {
      invalidatedCount += 1;
      return {
        ...fact,
        status: 'invalidated' as const,
        validTo: validFrom,
        invalidatedAt: nowISO,
        invalidatedByFactId: newId,
      };
    }
    return fact;
  });

  const existingIdx = updatedFacts.findIndex(f => f.id === newId);
  const newRecord: TemporalFactRecord = {
    ...input,
    id: newId,
    validFrom,
    status: 'active',
    createdAt: nowISO,
  };

  if (existingIdx >= 0) {
    updatedFacts[existingIdx] = { ...updatedFacts[existingIdx], ...newRecord };
  } else {
    updatedFacts.push(newRecord);
  }

  writeAllTemporalFacts(updatedFacts, factsDir);
  return { fact: newRecord, invalidatedCount };
}

export function queryTemporalTimeline(
  query: FactTimelineQuery,
  factsDir = path.join(process.cwd(), '.evidence-ledger'),
): TemporalFactRecord[] {
  const facts = readAllTemporalFacts(factsDir);
  return facts.filter(f => {
    if (query.subject && normalizeKey(f.subject) !== normalizeKey(query.subject)) return false;
    if (query.predicate && normalizeKey(f.predicate) !== normalizeKey(query.predicate)) return false;
    if (!query.includeInvalidated && f.status === 'invalidated') return false;
    return true;
  }).sort((a, b) => {
    const timeA = new Date(a.validFrom || a.createdAt).getTime() || 0;
    const timeB = new Date(b.validFrom || b.createdAt).getTime() || 0;
    return timeB - timeA;
  });
}
