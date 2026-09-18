import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelName, isValidApiKey, normalizeAiBaseUrl } from '../src/server/ai-config.ts';

test('validates API keys without accepting whitespace or oversized values', () => {
  assert.equal(isValidApiKey('sk-valid-key'), true);
  assert.equal(isValidApiKey('AIza-valid-key'), true);
  assert.equal(isValidApiKey('sk-invalid key'), false);
  assert.equal(isValidApiKey('x'.repeat(251)), false);
});

test('allows only HTTPS gateway hosts', () => {
  assert.equal(normalizeAiBaseUrl('https://gateway.pcg.io/'), 'https://gateway.pcg.io');
  assert.throws(() => normalizeAiBaseUrl('http://gateway.pcg.io'), /nicht freigegeben/);
  assert.throws(() => normalizeAiBaseUrl('https://evil.example'), /nicht freigegeben/);
  assert.throws(() => normalizeAiBaseUrl('https://user:pass@gateway.pcg.io'), /nicht freigegeben/);
});

test('accepts the current Gemini model and gateway model choices', () => {
  assert.equal(getModelName('gemini-3.8-flash', 'AIza-direct-key', ''), 'gemini-3.8-flash');
  assert.equal(getModelName('gemini-3.8-flash', 'sk-gateway-key', 'https://gateway.pcg.io'), 'gemini-3.8-flash');
  assert.equal(getModelName('gemini-3.7-flash', 'sk-gateway-key', 'https://gateway.pcg.io'), 'gemini-3.7-flash');
});
