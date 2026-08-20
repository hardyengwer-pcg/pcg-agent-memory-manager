import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeActionProposals } from '../server.ts';

const tasksContext = `Google Tasks - AUTORITATIVE AUFGABENZUSTAENDE:
OFFEN:
- [OFFEN] Onboarding Michael vorbereiten | Liste: My Tasks
ERLEDIGT:
- [ERLEDIGT] FNTV Cloud Function Timeout Alert pruefen | Liste: My Tasks`;

test('removes completed task from recommendations and proposals', () => {
  const text = `## 4. Konkrete naechste Schritte
- **FNTV Cloud Function Timeout Alert pruefen** - Faellig: heute
  Details: Fehler analysieren
- **Neuen Punkt pruefen** - Faellig: morgen
  Details: neu

<ACTION_PROPOSALS>
[
  {"type":"task","title":"FNTV Cloud Function Timeout Alert pruefen","details":{}},
  {"type":"task","title":"Neuen Punkt pruefen","details":{}}
]
</ACTION_PROPOSALS>`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /FNTV Cloud Function Timeout Alert/);
  assert.match(result, /Neuen Punkt pruefen/);
});

test('does not create a duplicate for an open task', () => {
  const text = `<ACTION_PROPOSALS>
[
  {"type":"task","title":"Onboarding Michael vorbereiten","details":{}},
  {"type":"task","title":"Anderen neuen Punkt pruefen","details":{}}
]
</ACTION_PROPOSALS>`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /Onboarding Michael vorbereiten/);
  assert.match(result, /Anderen neuen Punkt pruefen/);
});

test('filters completed recommendations without an action block', () => {
  const text = `## 4. Konkrete naechste Schritte
- **FNTV Cloud Function Timeout Alert pruefen** - Faellig: heute
  Details: Fehler analysieren
- **Neuen Punkt pruefen** - Faellig: morgen
  Details: neu`;

  const result = sanitizeActionProposals(text, tasksContext, '');

  assert.doesNotMatch(result, /FNTV Cloud Function Timeout Alert/);
  assert.match(result, /Neuen Punkt pruefen/);
});
