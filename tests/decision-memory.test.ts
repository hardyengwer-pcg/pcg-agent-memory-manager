import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordDecision, searchDecisions } from '../decision-memory.ts';

test('records a decision with rationale and alternatives', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-test-'));
  const decision = recordDecision({
    title: 'FNTV Restbudget nutzen',
    project: 'freenet TV',
    decision: 'Kleinere Anfragen über 35.5h Restbudget abwickeln statt neuem Projekt',
    rationale: 'Vermeidet Overhead von Sammelprojekten',
    alternativesConsidered: ['Neues Sammelprojekt anlegen', 'Einzelfaktura pro Ticket'],
    owner: 'Hardy Engwer',
    date: '2026-08-26',
    sourceUrl: 'https://docs.google.com/document/d/doc-1',
    tags: ['budget', 'freenet'],
  }, tmpDir);

  assert.equal(decision.project, 'freenet TV');
  assert.equal(decision.alternativesConsidered.length, 2);

  const results = searchDecisions({ project: 'freenet TV' }, tmpDir);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'FNTV Restbudget nutzen');
});

test('filters decisions by query term and tag', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-test-'));
  recordDecision({
    title: 'K&B Gemini Model Choice',
    project: 'Koenig & Bauer',
    decision: 'Gemini 2.5 Flash weiter nutzen statt 3.7 Flash',
    rationale: 'Gemini 3.7 Flash erwies sich als zu kostenintensiv',
    alternativesConsidered: ['Gemini 3.7 Flash', 'Claude Sonnet via Vertex'],
    owner: 'Hardy Engwer',
    tags: ['ai-model', 'costs'],
  }, tmpDir);

  recordDecision({
    title: 'Lorenz Funding Abwicklung',
    project: 'Lorenz Snack-World',
    decision: 'Intern umbuchen statt Funding-Antrag einreichen',
    rationale: 'Nicht Hardys Aufgabe und Funding läuft aus',
    alternativesConsidered: ['Screenshots und Antrag manuell einreichen'],
    tags: ['funding', 'admin'],
  }, tmpDir);

  const costDecisions = searchDecisions({ query: 'kostenintensiv' }, tmpDir);
  assert.equal(costDecisions.length, 1);
  assert.equal(costDecisions[0].project, 'Koenig & Bauer');

  const fundingDecisions = searchDecisions({ tag: 'funding' }, tmpDir);
  assert.equal(fundingDecisions.length, 1);
  assert.equal(fundingDecisions[0].title, 'Lorenz Funding Abwicklung');
});
