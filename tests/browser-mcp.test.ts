import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBrowserComparisonPrompt } from '../browser-mcp.ts';

test('builds a source-backed comparison prompt without tables', () => {
  const prompt = buildBrowserComparisonPrompt('Vergleiche die Projekte.', [
    { url: 'https://jira.example.com/DATA-123', content: 'Status: In Arbeit' },
    { url: 'https://odoo.example.com/project/42', content: 'Status: Neu' },
  ]);

  assert.match(prompt, /Vergleiche die Projekte/);
  assert.match(prompt, /jira\.example\.com/);
  assert.match(prompt, /odoo\.example\.com/);
  assert.match(prompt, /Verweise bei jeder Aussage/);
  assert.match(prompt, /ohne Markdown-Tabelle/);
});
