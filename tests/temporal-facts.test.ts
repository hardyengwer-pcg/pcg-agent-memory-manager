import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateFactId, queryTemporalTimeline, upsertTemporalFact } from '../temporal-facts.ts';

test('creates a temporal fact with validity window', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-test-'));
  const { fact, invalidatedCount } = upsertTemporalFact({
    subject: 'Sudipt Panda',
    predicate: 'capacity_status',
    object: 'looking_for_projects',
    validFrom: '2026-08-25T09:00:00Z',
    sourceUrl: 'https://example.test/weekly',
  }, tmpDir);

  assert.equal(invalidatedCount, 0);
  assert.equal(fact.status, 'active');
  assert.equal(fact.subject, 'Sudipt Panda');

  const timeline = queryTemporalTimeline({ subject: 'Sudipt Panda' }, tmpDir);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].object, 'looking_for_projects');
});

test('invalidates previous active fact when a contradictory fact arrives for same subject and predicate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-test-'));
  upsertTemporalFact({
    subject: 'Mario Pasculli',
    predicate: 'availability_status',
    object: 'fully_available',
    validFrom: '2026-08-10T00:00:00Z',
  }, tmpDir);

  const { fact: newFact, invalidatedCount } = upsertTemporalFact({
    subject: 'Mario Pasculli',
    predicate: 'availability_status',
    object: 'medical_leave_two_weeks',
    validFrom: '2026-08-24T00:00:00Z',
    sourceUrl: 'https://example.test/chat',
  }, tmpDir);

  assert.equal(invalidatedCount, 1);
  assert.equal(newFact.status, 'active');

  const activeTimeline = queryTemporalTimeline({ subject: 'Mario Pasculli' }, tmpDir);
  assert.equal(activeTimeline.length, 1);
  assert.equal(activeTimeline[0].object, 'medical_leave_two_weeks');

  const fullTimeline = queryTemporalTimeline({ subject: 'Mario Pasculli', includeInvalidated: true }, tmpDir);
  assert.equal(fullTimeline.length, 2);
  const oldFact = fullTimeline.find(f => f.object === 'fully_available');
  assert.equal(oldFact?.status, 'invalidated');
  assert.equal(oldFact?.validTo, '2026-08-24T00:00:00Z');
  assert.equal(oldFact?.invalidatedByFactId, newFact.id);
});
