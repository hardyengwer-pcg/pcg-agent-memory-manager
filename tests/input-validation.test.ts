import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTextField } from '../src/server/input-validation.ts';

test('validates required text fields and limits payload size', () => {
  assert.equal(validateTextField('ok', 'Titel', 10, true), null);
  assert.match(validateTextField('', 'Titel', 10, true) || '', /erforderlich/);
  assert.match(validateTextField(42, 'Titel', 10) || '', /Text sein/);
  assert.match(validateTextField('123456', 'Titel', 5) || '', /maximal 5/);
});
